//! Gatepass: pay, and get an SSH certificate that lets you into a machine for
//! exactly the minutes you paid for.
//!
//! The contract builds the OpenSSH user certificate itself (login user, expiry
//! and serial are decided here, never by the renter) and asks NEAR Chain
//! Signatures to sign it. Every machine has its own certificate authority key,
//! derived by the MPC network from this contract's account id and the machine
//! id, so no person ever holds it and a pass for one machine is worthless on
//! any other.

mod cert;

use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PublicKey,
};

/// Gas handed to the MPC `sign` call. The MPC contract requires at least 15 Tgas.
const MPC_SIGN_GAS: Gas = Gas::from_tgas(50);
/// Gas reserved for our callback after the signature comes back.
const SIGN_CALLBACK_GAS: Gas = Gas::from_tgas(30);
/// `buy_pass` refuses to start with less than this, so it cannot run dry halfway.
const MIN_BUY_GAS: Gas = Gas::from_tgas(100);
const CA_KEY_GAS: Gas = Gas::from_tgas(15);
const CA_KEY_CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// The MPC contract charges exactly 1 yoctoNEAR per signature.
const MPC_SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);

/// Flat fees that pay for the storage a machine or a pass occupies in this
/// contract, so nobody can fill it up for free. They stay with the contract.
const MACHINE_STORAGE_FEE: NearToken = NearToken::from_millinear(20);
const PASS_STORAGE_FEE: NearToken = NearToken::from_millinear(10);

const MAX_MINUTES: u32 = 240;
/// Certificates are valid from one minute before purchase, to absorb clock skew.
const CLOCK_SKEW_SECONDS: u64 = 60;
/// A pass still pending this long after its expiry can be refunded by its buyer.
const STUCK_GRACE_SECONDS: u64 = 600;
/// The wrapper the host installs; it ends the session at the given unix time.
const SESSION_WRAPPER: &str = "/usr/local/bin/gatepass-session";
const MAX_PAGE: u32 = 50;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Machines,
    Passes,
    MachinePasses,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Machine {
    pub id: String,
    pub owner: AccountId,
    /// Display only: where renters should connect.
    pub host: String,
    pub port: u16,
    /// The unix user every pass for this machine logs in as.
    pub login_user: String,
    pub price_per_minute: NearToken,
    /// Earned and not yet withdrawn.
    pub earnings: NearToken,
    pub total_earned: NearToken,
    pub passes_issued: u64,
    pub active: bool,
    /// This machine's own CA key (`ssh-ed25519 AAAA... gatepass-ca:<id>`), as
    /// reported by the MPC contract. The machine's sshd trusts only this key.
    /// Passes cannot be sold until it is known.
    pub ca_public_key: Option<String>,
}

/// A machine as views return it: the stored record plus what is derived.
#[near(serializers = [json])]
pub struct MachineView {
    #[serde(flatten)]
    pub machine: Machine,
    /// Unix seconds until which the machine is taken by its current pass;
    /// 0 when it is free. Only one pass can be active on a machine at a time.
    pub busy_until: u64,
    /// The machine's SSH host key (`ssh-ed25519 AAAA...`), if the owner has
    /// published it. Renters pin it, so they know they reached this machine.
    pub host_key: Option<String>,
}

impl std::ops::Deref for MachineView {
    type Target = Machine;
    fn deref(&self) -> &Machine {
        &self.machine
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PassStatus {
    /// Paid for; waiting for the MPC network to sign.
    Pending,
    /// Signed; `certificate` is ready to use.
    Signed,
    /// Signing failed; the buyer was refunded.
    Failed,
}

#[near(serializers = [borsh])]
pub struct Pass {
    serial: u64,
    machine_id: String,
    buyer: AccountId,
    renter_pk: [u8; 32],
    minutes: u32,
    valid_after: u64,
    valid_before: u64,
    paid: NearToken,
    /// Certificate fields 1..13, exactly as sent to the MPC for signing.
    cert_body: Vec<u8>,
    signature: Option<Vec<u8>>,
    status: PassStatus,
}

/// What views and the `buy_pass` result return.
#[near(serializers = [json])]
pub struct PassView {
    pub serial: u64,
    pub machine_id: String,
    pub buyer: AccountId,
    pub key_id: String,
    pub ssh_pubkey: String,
    pub login_user: String,
    pub host: String,
    pub port: u16,
    pub minutes: u32,
    /// Unix seconds.
    pub valid_after: u64,
    pub valid_before: u64,
    pub paid: NearToken,
    pub status: PassStatus,
    /// One-line OpenSSH certificate; write it to `<key>-cert.pub`.
    pub certificate: Option<String>,
}

#[near(serializers = [json])]
pub struct Config {
    pub mpc_contract: AccountId,
    /// A machine's CA key is derived with the path `<ca_path>/<machine id>`.
    pub ca_path: String,
    pub ca_domain_id: u64,
    pub pass_count: u64,
    pub machine_count: u32,
    pub max_minutes: u32,
    /// One-off fee to register a machine.
    pub machine_storage_fee: NearToken,
    /// Added to the price of every pass.
    pub pass_storage_fee: NearToken,
}

/// What a pass costs: attach `total` to `buy_pass`.
#[near(serializers = [json])]
pub struct Quote {
    pub machine_id: String,
    pub minutes: u32,
    /// `price_per_minute * minutes`; goes to the machine's owner.
    pub price: NearToken,
    pub storage_fee: NearToken,
    pub total: NearToken,
    /// Unix seconds until which the machine is in use; 0 if it can be rented now.
    pub busy_until: u64,
}

/// The MPC contract's answer for an Ed25519 request.
#[near(serializers = [json])]
pub struct SignResponse {
    pub scheme: String,
    pub signature: Vec<u8>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Gatepass {
    mpc_contract: AccountId,
    ca_path: String,
    ca_domain_id: u64,
    machines: IterableMap<String, Machine>,
    passes: LookupMap<u64, Pass>,
    /// (machine id, n-th pass of that machine) -> serial
    machine_passes: LookupMap<(String, u64), u64>,
    next_serial: u64,
}

#[near]
impl Gatepass {
    #[init]
    #[private]
    pub fn new(mpc_contract: AccountId, ca_path: Option<String>, ca_domain_id: Option<u64>) -> Self {
        Self {
            mpc_contract,
            ca_path: ca_path.unwrap_or_else(|| "gatepass-ca-v1".to_string()),
            ca_domain_id: ca_domain_id.unwrap_or(1),
            machines: IterableMap::new(StorageKey::Machines),
            passes: LookupMap::new(StorageKey::Passes),
            machine_passes: LookupMap::new(StorageKey::MachinePasses),
            next_serial: 1,
        }
    }

    // ---------- certificate authority keys ----------

    /// Ask the MPC contract which key it signs with for this machine and store
    /// it. Anyone may call this; the answer only ever comes from the MPC.
    pub fn refresh_ca_key(&mut self, machine_id: String) -> Promise {
        require!(self.machines.contains_key(&machine_id), "no such machine");
        self.fetch_ca_key(machine_id)
    }

    #[private]
    pub fn on_ca_key(&mut self, machine_id: String, #[callback_result] result: Result<String, PromiseError>) -> MachineView {
        let key = result.unwrap_or_else(|_| env::panic_str("MPC contract did not return a derived key"));
        let parsed: PublicKey = key.parse().unwrap_or_else(|_| env::panic_str("MPC returned an unparsable key"));
        let bytes = parsed.as_bytes();
        // near_sdk::PublicKey is one curve-type byte (0 = ed25519) followed by the key.
        require!(bytes.len() == 33 && bytes[0] == 0, "MPC key is not Ed25519; check ca_domain_id");
        let pk: [u8; 32] = bytes[1..].try_into().unwrap();
        let line = cert::pubkey_line(&pk, &format!("gatepass-ca:{machine_id}"));
        let machine = self.machines.get_mut(&machine_id).unwrap_or_else(|| env::panic_str("no such machine"));
        machine.ca_public_key = Some(line.clone());
        emit("ca_key_set", json!({ "machine_id": machine_id, "ca_public_key": line, "mpc_key": key }));
        self.machine_view(&machine_id).unwrap()
    }

    /// The line a machine's host puts in its `TrustedUserCAKeys` file.
    pub fn ca_public_key(&self, machine_id: String) -> Option<String> {
        self.machines.get(&machine_id).and_then(|m| m.ca_public_key.clone())
    }

    // ---------- machines ----------

    /// Register a machine; the caller becomes its owner. Costs a one-off
    /// storage fee (see `get_config`); anything attached above it is returned.
    /// Resolves to the machine once its own CA key has been fetched from the
    /// MPC contract.
    #[payable]
    pub fn register_machine(&mut self, id: String, host: String, port: u16, login_user: String, price_per_minute: NearToken) -> Promise {
        require!(is_slug(&id, 32), "id must be 1-32 characters of a-z, 0-9, '-' or '_'");
        require!(is_unix_user(&login_user), "login_user must be a plain unix user name");
        require!(login_user != "root", "login_user must not be root");
        require!(is_hostname(&host), "host must be a host name or IP address (letters, digits, '.', '-', ':')");
        require!(port != 0, "port must not be 0");
        require!(!price_per_minute.is_zero(), "price_per_minute must be more than 0");
        require!(!self.machines.contains_key(&id), "a machine with this id already exists");
        let deposit = env::attached_deposit();
        require!(deposit >= MACHINE_STORAGE_FEE, format!("attach the {MACHINE_STORAGE_FEE} machine storage fee"));
        let change = deposit.saturating_sub(MACHINE_STORAGE_FEE);
        if !change.is_zero() {
            Promise::new(env::predecessor_account_id()).transfer(change).detach();
        }

        let machine = Machine {
            id: id.clone(),
            owner: env::predecessor_account_id(),
            host,
            port,
            login_user,
            price_per_minute,
            earnings: NearToken::from_yoctonear(0),
            total_earned: NearToken::from_yoctonear(0),
            passes_issued: 0,
            active: true,
            ca_public_key: None,
        };
        emit("machine_registered", json!({ "machine_id": machine.id, "owner": machine.owner, "price_per_minute": machine.price_per_minute }));
        self.machines.insert(id.clone(), machine);
        self.fetch_ca_key(id)
    }

    /// Owner only: pause or resume selling passes for a machine.
    pub fn set_machine_active(&mut self, machine_id: String, active: bool) {
        let machine = self.machines.get_mut(&machine_id).unwrap_or_else(|| env::panic_str("no such machine"));
        require!(env::predecessor_account_id() == machine.owner, "only the machine owner can do this");
        machine.active = active;
    }

    /// Owner only: publish the machine's SSH host key (`ssh-ed25519 AAAA...`,
    /// the line in /etc/ssh/ssh_host_ed25519_key.pub). Renters pin it instead
    /// of trusting whatever answers at the address.
    pub fn set_host_key(&mut self, machine_id: String, host_key: String) {
        let machine = self.machines.get(&machine_id).unwrap_or_else(|| env::panic_str("no such machine"));
        require!(env::predecessor_account_id() == machine.owner, "only the machine owner can do this");
        let pk = cert::parse_pubkey_line(&host_key).unwrap_or_else(|_| env::panic_str("host_key must be an ssh-ed25519 public key line"));
        env::storage_write(&host_key_storage_key(&machine_id), &pk);
        emit("host_key_set", json!({ "machine_id": machine_id, "host_key": cert::pubkey_line(&pk, &machine_id) }));
    }

    pub fn get_machine(&self, machine_id: String) -> Option<MachineView> {
        self.machine_view(&machine_id)
    }

    pub fn list_machines(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<MachineView> {
        self.machines
            .keys()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize)
            .filter_map(|id| self.machine_view(id))
            .collect()
    }

    // ---------- passes ----------

    /// What `minutes` on a machine cost right now.
    pub fn quote(&self, machine_id: String, minutes: u32) -> Quote {
        require!((1..=MAX_MINUTES).contains(&minutes), "minutes must be between 1 and 240");
        let machine = self.machines.get(&machine_id).unwrap_or_else(|| env::panic_str("no such machine"));
        let price = machine.price_per_minute.checked_mul(minutes as u128).unwrap_or_else(|| env::panic_str("price overflow"));
        let total = price.checked_add(PASS_STORAGE_FEE).unwrap_or_else(|| env::panic_str("price overflow"));
        let busy_until = self.busy_until(&machine_id);
        Quote { machine_id, minutes, price, storage_fee: PASS_STORAGE_FEE, total, busy_until }
    }

    /// Pay for `minutes` on a machine. `ssh_pubkey` is the renter's own
    /// `ssh-ed25519 AAAA...` public key. Attach the `total` from `quote`
    /// (anything above it is returned). Resolves to the signed pass, or
    /// refunds the whole payment if the MPC network does not sign.
    ///
    /// A machine has one renter at a time: while a pass is active (or being
    /// signed), nobody else can buy one for that machine.
    #[payable]
    pub fn buy_pass(&mut self, machine_id: String, ssh_pubkey: String, minutes: u32) -> Promise {
        require!(env::prepaid_gas() >= MIN_BUY_GAS, "attach at least 100 Tgas");
        require!((1..=MAX_MINUTES).contains(&minutes), "minutes must be between 1 and 240");
        let renter_pk = cert::parse_pubkey_line(&ssh_pubkey).unwrap_or_else(|e| env::panic_str(e));
        let now = env::block_timestamp() / 1_000_000_000;
        let busy_until = self.busy_until(&machine_id);
        require!(busy_until == 0, format!("this machine is in use for another {} seconds (until unix time {busy_until})", busy_until.saturating_sub(now)));

        let machine = self.machines.get_mut(&machine_id).unwrap_or_else(|| env::panic_str("no such machine"));
        require!(machine.active, "this machine is not accepting passes");
        let ca_pk = machine
            .ca_public_key
            .as_deref()
            .and_then(|line| cert::parse_pubkey_line(line).ok())
            .unwrap_or_else(|| env::panic_str("this machine has no CA key yet; call refresh_ca_key for it"));
        let price = machine
            .price_per_minute
            .checked_mul(minutes as u128)
            .unwrap_or_else(|| env::panic_str("price overflow"));
        let total = price.checked_add(PASS_STORAGE_FEE).unwrap_or_else(|| env::panic_str("price overflow"));
        let deposit = env::attached_deposit();
        require!(deposit >= total, format!("underpaid: {minutes} minutes cost {price} plus the {PASS_STORAGE_FEE} storage fee, attached {deposit}"));

        let buyer = env::predecessor_account_id();
        let serial = self.next_serial;
        self.next_serial += 1;

        let valid_after = now - CLOCK_SKEW_SECONDS;
        let valid_before = now + minutes as u64 * 60;

        // The contract alone fixes the login user, the expiry and the serial.
        let nonce: [u8; 32] = env::sha256_array(&[env::random_seed().as_slice(), &serial.to_be_bytes()].concat());
        let cert_body = cert::cert_body(&cert::CertFields {
            nonce: &nonce,
            renter_pk: &renter_pk,
            serial,
            key_id: &key_id(&machine_id, &buyer, serial),
            principal: &machine.login_user,
            valid_after,
            valid_before,
            force_command: &format!("{SESSION_WRAPPER} {valid_before}"),
            ca_pk: &ca_pk,
        });

        let sign_args = json!({
            "request": {
                "path": ca_path_for(&self.ca_path, &machine_id),
                "domain_id": self.ca_domain_id,
                "payload_v2": { "Eddsa": hex(&cert_body) },
            }
        });

        let nth = machine.passes_issued;
        machine.passes_issued += 1;
        self.machine_passes.insert((machine_id.clone(), nth), serial);
        self.passes.insert(
            serial,
            Pass { serial, machine_id, buyer: buyer.clone(), renter_pk, minutes, valid_after, valid_before, paid: price, cert_body, signature: None, status: PassStatus::Pending },
        );

        // Hand back anything paid above the total straight away.
        let change = deposit.saturating_sub(total);
        if !change.is_zero() {
            Promise::new(buyer).transfer(change).detach();
        }

        Promise::new(self.mpc_contract.clone())
            .function_call("sign".to_string(), sign_args.to_string().into_bytes(), MPC_SIGN_DEPOSIT, MPC_SIGN_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(SIGN_CALLBACK_GAS).on_pass_signed(serial))
    }

    #[private]
    pub fn on_pass_signed(&mut self, serial: u64, #[callback_result] result: Result<near_sdk::serde_json::Value, PromiseError>) -> PassView {
        let pass = self.passes.get(&serial).unwrap_or_else(|| env::panic_str("no such pass"));
        require!(pass.status == PassStatus::Pending, "pass is not pending");

        // Accept only a signature that really verifies for this certificate
        // under the machine's CA key, so a stored pass is always one that
        // machine's sshd will accept.
        let signature: Option<[u8; 64]> = result
            .ok()
            .and_then(|value| near_sdk::serde_json::from_value::<SignResponse>(value).ok())
            .filter(|r| r.scheme == "Ed25519")
            .and_then(|r| <[u8; 64]>::try_from(r.signature).ok())
            .filter(|sig| self.signature_is_valid(serial, sig));

        match signature {
            Some(sig) => self.mark_signed(serial, sig),
            None => self.mark_failed(serial).detach(),
        }
        self.pass_view(serial).unwrap()
    }

    /// Finish a pass by hand. The MPC's signature is public in its own
    /// receipt, so if our callback ever failed after the MPC signed, anyone
    /// (typically the machine owner) can submit that signature here. It is
    /// accepted only if it verifies; the pass is then credited as usual.
    pub fn settle_pass(&mut self, serial: u64, signature: Base64VecU8) -> PassView {
        let pass = self.passes.get(&serial).unwrap_or_else(|| env::panic_str("no such pass"));
        require!(pass.status == PassStatus::Pending, "pass is not pending");
        let sig: [u8; 64] = signature.0.try_into().unwrap_or_else(|_| env::panic_str("signature must be 64 bytes"));
        require!(self.signature_is_valid(serial, &sig), "signature does not verify for this pass");
        self.mark_signed(serial, sig);
        self.pass_view(serial).unwrap()
    }

    /// Safety net: if a pass was never signed, the buyer can take the payment
    /// back once the pass would have expired anyway.
    pub fn refund_stuck_pass(&mut self, serial: u64) -> Promise {
        let pass = self.passes.get(&serial).unwrap_or_else(|| env::panic_str("no such pass"));
        require!(env::predecessor_account_id() == pass.buyer, "only the buyer can do this");
        require!(pass.status == PassStatus::Pending, "pass is not pending");
        let now = env::block_timestamp() / 1_000_000_000;
        require!(now > pass.valid_before + STUCK_GRACE_SECONDS, "too early; wait until 10 minutes after the pass expiry");
        self.mark_failed(serial)
    }

    pub fn get_pass(&self, serial: u64) -> Option<PassView> {
        self.pass_view(serial)
    }

    /// Passes of one machine, newest first.
    pub fn list_passes(&self, machine_id: String, from_index: Option<u64>, limit: Option<u32>) -> Vec<PassView> {
        let total = self.machines.get(&machine_id).map(|m| m.passes_issued).unwrap_or(0);
        let skip = from_index.unwrap_or(0);
        (0..total)
            .rev()
            .skip(skip as usize)
            .take(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize)
            .filter_map(|nth| self.machine_passes.get(&(machine_id.clone(), nth)))
            .filter_map(|serial| self.pass_view(*serial))
            .collect()
    }

    /// Passes across all machines, newest first.
    pub fn list_recent_passes(&self, limit: Option<u32>) -> Vec<PassView> {
        (1..self.next_serial)
            .rev()
            .take(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize)
            .filter_map(|serial| self.pass_view(serial))
            .collect()
    }

    /// The exact bytes the MPC signed for a pass, for anyone who wants to check.
    pub fn get_pass_signed_bytes(&self, serial: u64) -> Option<Base64VecU8> {
        self.passes.get(&serial).map(|p| Base64VecU8::from(p.cert_body.clone()))
    }

    // ---------- earnings ----------

    /// Owner only: pay out everything the machine has earned so far.
    pub fn withdraw(&mut self, machine_id: String) -> Promise {
        let machine = self.machines.get_mut(&machine_id).unwrap_or_else(|| env::panic_str("no such machine"));
        require!(env::predecessor_account_id() == machine.owner, "only the machine owner can withdraw");
        let amount = machine.earnings;
        require!(!amount.is_zero(), "nothing to withdraw");
        machine.earnings = NearToken::from_yoctonear(0);
        emit("withdrawn", json!({ "machine_id": machine_id, "owner": machine.owner, "amount": amount }));
        Promise::new(machine.owner.clone()).transfer(amount)
    }

    pub fn get_config(&self) -> Config {
        Config {
            mpc_contract: self.mpc_contract.clone(),
            ca_path: self.ca_path.clone(),
            ca_domain_id: self.ca_domain_id,
            pass_count: self.next_serial - 1,
            machine_count: self.machines.len(),
            max_minutes: MAX_MINUTES,
            machine_storage_fee: MACHINE_STORAGE_FEE,
            pass_storage_fee: PASS_STORAGE_FEE,
        }
    }
}

impl Gatepass {
    /// Unix seconds until which the machine's latest pass holds it; 0 if free.
    /// Passes on a machine never overlap, so only the latest one can be live.
    /// A pass that is still being signed counts; a failed one does not.
    fn busy_until(&self, machine_id: &String) -> u64 {
        let Some(machine) = self.machines.get(machine_id) else { return 0 };
        if machine.passes_issued == 0 {
            return 0;
        }
        let now = env::block_timestamp() / 1_000_000_000;
        self.machine_passes
            .get(&(machine_id.clone(), machine.passes_issued - 1))
            .and_then(|serial| self.passes.get(serial))
            .filter(|pass| pass.status != PassStatus::Failed && pass.valid_before > now)
            .map_or(0, |pass| pass.valid_before)
    }

    fn machine_view(&self, machine_id: &String) -> Option<MachineView> {
        let machine = self.machines.get(machine_id)?.clone();
        let host_key = env::storage_read(&host_key_storage_key(machine_id))
            .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
            .map(|pk| cert::pubkey_line(&pk, machine_id));
        Some(MachineView { machine, busy_until: self.busy_until(machine_id), host_key })
    }

    fn fetch_ca_key(&self, machine_id: String) -> Promise {
        let args = json!({
            "path": ca_path_for(&self.ca_path, &machine_id),
            "predecessor": env::current_account_id(),
            "domain_id": self.ca_domain_id,
        });
        Promise::new(self.mpc_contract.clone())
            .function_call("derived_public_key".to_string(), args.to_string().into_bytes(), NearToken::from_yoctonear(0), CA_KEY_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(CA_KEY_CALLBACK_GAS).on_ca_key(machine_id))
    }

    fn signature_is_valid(&self, serial: u64, signature: &[u8; 64]) -> bool {
        let Some(pass) = self.passes.get(&serial) else { return false };
        self.machines
            .get(&pass.machine_id)
            .and_then(|m| m.ca_public_key.as_deref())
            .and_then(|line| cert::parse_pubkey_line(line).ok())
            .is_some_and(|ca_pk| env::ed25519_verify(signature, &pass.cert_body, &ca_pk))
    }

    /// Store the signature and credit the machine. The caller has verified it.
    fn mark_signed(&mut self, serial: u64, signature: [u8; 64]) {
        let pass = self.passes.get_mut(&serial).unwrap_or_else(|| env::panic_str("no such pass"));
        pass.signature = Some(signature.to_vec());
        pass.status = PassStatus::Signed;
        let (machine_id, buyer, paid, valid_before) = (pass.machine_id.clone(), pass.buyer.clone(), pass.paid, pass.valid_before);
        let machine = self.machines.get_mut(&machine_id).unwrap_or_else(|| env::panic_str("no such machine"));
        machine.earnings = machine.earnings.saturating_add(paid);
        machine.total_earned = machine.total_earned.saturating_add(paid);
        emit("pass_issued", json!({ "serial": serial, "machine_id": machine_id, "buyer": buyer, "paid": paid, "valid_before": valid_before }));
    }

    /// Mark the pass failed and send the buyer everything they paid for it.
    fn mark_failed(&mut self, serial: u64) -> Promise {
        let pass = self.passes.get_mut(&serial).unwrap_or_else(|| env::panic_str("no such pass"));
        pass.status = PassStatus::Failed;
        let (machine_id, buyer) = (pass.machine_id.clone(), pass.buyer.clone());
        let refund = pass.paid.saturating_add(PASS_STORAGE_FEE);
        emit("pass_failed", json!({ "serial": serial, "machine_id": machine_id, "buyer": buyer, "refunded": refund }));
        Promise::new(buyer).transfer(refund)
    }

    fn pass_view(&self, serial: u64) -> Option<PassView> {
        let pass = self.passes.get(&serial)?;
        let machine = self.machines.get(&pass.machine_id)?;
        let certificate = pass
            .signature
            .as_ref()
            .and_then(|sig| <&[u8; 64]>::try_from(sig.as_slice()).ok())
            .map(|sig| format!("{} {}", cert::cert_line(&pass.cert_body, sig), key_id(&pass.machine_id, &pass.buyer, serial)));
        Some(PassView {
            serial,
            machine_id: pass.machine_id.clone(),
            buyer: pass.buyer.clone(),
            key_id: key_id(&pass.machine_id, &pass.buyer, serial),
            ssh_pubkey: cert::pubkey_line(&pass.renter_pk, "gatepass-renter"),
            login_user: machine.login_user.clone(),
            host: machine.host.clone(),
            port: machine.port,
            minutes: pass.minutes,
            valid_after: pass.valid_after,
            valid_before: pass.valid_before,
            paid: pass.paid,
            status: pass.status,
            certificate,
        })
    }
}

fn key_id(machine_id: &str, buyer: &AccountId, serial: u64) -> String {
    format!("gatepass:{machine_id}:{buyer}:{serial}")
}

/// The MPC derivation path of one machine's CA key. Machine ids are slugs
/// (no '/' or ','), so two machines can never share a path.
fn ca_path_for(prefix: &str, machine_id: &str) -> String {
    format!("{prefix}/{machine_id}")
}

/// Host keys live under their own storage prefix, next to the collections.
fn host_key_storage_key(machine_id: &str) -> Vec<u8> {
    [b"hostkey:".as_slice(), machine_id.as_bytes()].concat()
}

fn is_slug(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
}

/// Host names and IP addresses only: this string ends up on the renter's ssh
/// command line, so it must not be able to look like an option.
fn is_hostname(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && !s.starts_with('-')
        && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-' || c == b':')
}

fn is_unix_user(s: &str) -> bool {
    is_slug(s, 32) && !s.starts_with('-') && !s.as_bytes()[0].is_ascii_digit()
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 15) as usize] as char);
    }
    out
}

/// NEP-297 event log.
fn emit(event: &str, data: near_sdk::serde_json::Value) {
    log!("EVENT_JSON:{}", json!({ "standard": "gatepass", "version": "1.0.0", "event": event, "data": [data] }));
}

#[cfg(test)]
mod tests;
