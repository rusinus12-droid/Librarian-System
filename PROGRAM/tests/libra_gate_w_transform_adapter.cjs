'use strict';

const gateW = require('./libra_gate_w_transform.cjs');

module.exports = source => {
  const transformed = gateW.applyGateWTransform(source);
  gateW.validateTransformedSyntax(transformed);
  return { source: transformed, labels: [gateW.TRANSFORM_ID] };
};
