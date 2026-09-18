/* eslint-env node */
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict'

const { loadWrapped, register } = require('./register-better-sqlite3-node.cjs')

register()
module.exports = loadWrapped()
