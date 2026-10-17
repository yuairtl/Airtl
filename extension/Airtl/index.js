// Author: Airtl yu
// Contact: yuairtl@outlook.com
// The extension host never loads the native DLL itself.
const fs = require('fs'), path = require('path');
const packaged = path.join(__dirname, 'native.js');
module.exports = require('./isolated').create(fs.existsSync(packaged) ? packaged : path.join(__dirname, '../../index.js'));
