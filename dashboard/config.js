// The one place to point the dashboard at a different deployment.
// `?contract=<account>` and `?rpc=<url>` in the page URL override these.
export default {
  contract: 'gatepass.testnet',
  // Tried in order; when one refuses (public endpoints rate-limit), the next is used.
  rpc: ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://rpc.testnet.near.org'],
  explorer: 'https://testnet.nearblocks.io',
};
