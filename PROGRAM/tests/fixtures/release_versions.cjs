// Release identity assertions use the independently generated distribution
// manifest. Behaviour assertions remain in the calling test unchanged.
'use strict';
const fs = require('node:fs'), path = require('node:path');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../program-manifest.json'), 'utf8'));
function releaseVersion(owner) {
 const value = owner === 'storage' ? manifest.storageSdkVersion : manifest.plugins?.[owner];
 if (!/^\d+\.\d+\.\d+$/.test(value || '')) throw Error('Missing manifest version: ' + owner);
 return value;
}
function releaseText(template) { return template.replace(/\{(libra|hayaku|flashback|lia|retrace|storage)\}/g, (_, owner) => releaseVersion(owner)); }
function releasePattern(template, flags = '') { return new RegExp(template.replace(/\{(libra|hayaku|flashback|lia|retrace|storage)\}/g, (_, owner) => releaseVersion(owner).replace(/\./g, '\\.')), flags); }
module.exports = { releaseVersion, releaseText, releasePattern };
