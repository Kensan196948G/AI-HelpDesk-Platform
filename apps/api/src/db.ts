import postgres from 'postgres';
import { config } from './config.js';
import { assertTestDatabase } from './lib/test-database.js';

// config 読込後に呼出側が値を変更しても、test DB 以外の client は生成しない。
assertTestDatabase({
  NODE_ENV: config.NODE_ENV,
  DATABASE_URL: config.DATABASE_URL,
  AIHD_TEST_DATABASE_NAME: process.env.AIHD_TEST_DATABASE_NAME,
});

export const sql = postgres(config.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: () => {},
});

export type Database = typeof sql;
