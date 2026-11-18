import mysql from 'mysql2/promise';

const pools = new Map();

export function createMysqlPool(databaseUrl) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to create a MySQL pool.');
  }

  if (!pools.has(databaseUrl)) {
    pools.set(databaseUrl, mysql.createPool(databaseUrl));
  }

  return pools.get(databaseUrl);
}
