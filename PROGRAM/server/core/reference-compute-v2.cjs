'use strict';
// Retired in 0.3.18: the former reference-v2 handler bypassed the standard auth,
// owner/scope checks and Compute lifecycle. Do not discover databases or start
// workers here. A future integration must register a validated normal operation.
module.exports = Object.freeze({
  _test: require('./reference-index-pure.cjs'),
  tryHandle: async () => false,
  disabled: true,
  reason: 'reference_v2_requires_authenticated_owner_scoped_compute'
});
