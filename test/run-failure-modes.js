#!/usr/bin/env node
/*
 * Standalone runner for the failure-mode harness.
 * Does not require mocha's CLI; uses node:test if present, otherwise a
 * tiny tap-like runner. Invoke:
 *
 *   node test/run-failure-modes.js
 */

const path = require('node:path');
const Module = require('node:module');

// Make require('mocha') work even when node_modules is incomplete.
try {
  require.resolve('mocha');
} catch {
  const mochaRoot = '/tmp/mocha-tools/node_modules';
  const orig = Module._nodeModulePaths;
  Module._nodeModulePaths = function (from) {
    return [mochaRoot, path.join(process.cwd(), 'node_modules'), ...orig(from)];
  };
}

require('./integration/failure-modes.test.js');
