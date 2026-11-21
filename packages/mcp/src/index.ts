#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { safeText } from '@pronoia/core';
import { z } from 'zod';
import { createServer } from './server.js';

try {
  const server = createServer();
  server.server.onerror = () => {
    process.stderr.write('Pronoia MCP: invalid protocol message.\n');
  };
  await server.connect(
    new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: 1024 * 1024,
    }),
  );
} catch (error) {
  const message =
    error instanceof z.ZodError
      ? 'Invalid Pronoia MCP agent configuration.'
      : error instanceof Error
        ? safeText(error.message, 1000)
        : 'Unable to initialize Pronoia MCP.';
  process.stderr.write(`Pronoia MCP: ${message}\n`);
  process.exitCode = 1;
}
