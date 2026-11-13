// lib/db.js — Postgres pool. DATABASE_URL points at the private compose-network database.
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Inside the compose network TLS is not used; set DATABASE_SSL=true if the DB is ever remote.
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
  max: 10,
});

module.exports = { pool };
