import assert from "node:assert/strict";
import { test } from "node:test";
import { loadEnvironment } from "../../config/env.ts";
import { createPostgresPool, bindNamedParameters } from "./postgres.ts";

test("PostgreSQL adapter binds named inputs positionally without duplicating values", () => {
  assert.deepEqual(
    bindNamedParameters(
      'SELECT @queryId AS "queryId" WHERE @queryId = @otherId',
      { queryId: "query-1", otherId: "query-2" },
    ),
    {
      text: 'SELECT $1 AS "queryId" WHERE $1 = $2',
      values: ["query-1", "query-2"],
    },
  );
});

test("PostgreSQL adapter rejects missing named inputs", () => {
  assert.throws(
    () => bindNamedParameters("SELECT @missing", {}),
    /Missing SQL parameter: missing/,
  );
});

test("Supabase database URL is required only when creating a pool", () => {
  const environment = loadEnvironment({ NODE_ENV: "test" });
  assert.throws(
    () => createPostgresPool(environment),
    /DATABASE_URL must be configured/,
  );
});

test("PostgreSQL adapter rejects non-PostgreSQL connection URLs", () => {
  const environment = loadEnvironment({
    NODE_ENV: "test",
    DATABASE_URL: "https://example.invalid/database",
  });
  assert.throws(
    () => createPostgresPool(environment),
    /DATABASE_URL must use the PostgreSQL protocol/,
  );
});

test("development keeps TLS encryption but skips certificate-chain verification", async () => {
  const pool = createPostgresPool(
    loadEnvironment({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://postgres:placeholder@localhost:5432/postgres",
    }),
  );

  try {
    assert.ok(pool.options.ssl && typeof pool.options.ssl === "object");
    assert.equal(pool.options.ssl.rejectUnauthorized, false);
  } finally {
    await pool.end();
  }
});

test("production keeps certificate-chain verification enabled", async () => {
  const pool = createPostgresPool(
    loadEnvironment({
      NODE_ENV: "production",
      PUBLIC_ORIGIN: "https://game.example.com",
      DATABASE_URL: "postgresql://postgres:placeholder@localhost:5432/postgres",
    }),
  );

  try {
    assert.ok(pool.options.ssl && typeof pool.options.ssl === "object");
    assert.equal(pool.options.ssl.rejectUnauthorized, true);
  } finally {
    await pool.end();
  }
});

test("production requires an HTTPS public origin for secure sessions", () => {
  assert.throws(
    () =>
      loadEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://postgres:placeholder@localhost:5432/postgres",
      }),
    /PUBLIC_ORIGIN is required in production/,
  );
  assert.throws(
    () =>
      loadEnvironment({
        NODE_ENV: "production",
        PUBLIC_ORIGIN: "http://game.example.com",
        DATABASE_URL: "postgresql://postgres:placeholder@localhost:5432/postgres",
      }),
    /PUBLIC_ORIGIN must use HTTPS in production/,
  );
  assert.equal(
    loadEnvironment({
      NODE_ENV: "production",
      PUBLIC_ORIGIN: "https://game.example.com",
      DATABASE_URL: "postgresql://postgres:placeholder@localhost:5432/postgres",
    }).PUBLIC_ORIGIN,
    "https://game.example.com",
  );
});
