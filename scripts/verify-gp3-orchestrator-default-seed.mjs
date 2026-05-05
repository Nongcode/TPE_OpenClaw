import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Client } from "pg";

const foundationMigrationPath = path.resolve("backend/migrations/20260504_gp3_orchestrator_foundation.sql");
const seedMigrationPath = path.resolve("backend/migrations/20260504_gp3_orchestrator_default_seed.sql");

function stripTransaction(sql) {
  return sql.replace(/^\s*BEGIN;\s*/i, "").replace(/\s*COMMIT;\s*$/i, "");
}

function getConnectionConfig() {
  return {
    user: process.env.PGUSER || "openclaw_readonly",
    host: process.env.PGHOST || "localhost",
    database: process.env.PGDATABASE || "openclaw",
    password: process.env.PGPASSWORD || "123",
    port: Number(process.env.PGPORT || 5432),
  };
}

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function queryValues(client, sql) {
  const result = await client.query(sql);
  return result.rows;
}

async function main() {
  const foundationSql = stripTransaction(await fs.readFile(foundationMigrationPath, "utf8"));
  const seedSql = stripTransaction(await fs.readFile(seedMigrationPath, "utf8"));
  const client = new Client(getConnectionConfig());
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path TO pg_temp");
    await client.query(foundationSql);
    await client.query(seedSql);
    await client.query(seedSql);

    const templates = await queryValues(
      client,
      `
        SELECT code, "roleType", status
        FROM "AgentTemplates"
        ORDER BY code
      `,
    );
    const instances = await queryValues(
      client,
      `
        SELECT "instanceCode", "displayName", "instanceType", status
        FROM "AgentInstances"
        ORDER BY "instanceCode"
      `,
    );
    const bindings = await queryValues(
      client,
      `
        SELECT manager."instanceCode" AS manager_code, worker.code AS worker_code, binding.priority, binding."isEnabled"
        FROM "ManagerWorkerBindings" binding
        JOIN "AgentInstances" manager ON manager.id = binding."managerInstanceId"
        LEFT JOIN "AgentTemplates" worker ON worker.id = binding."workerTemplateId"
        ORDER BY binding.priority, worker.code
      `,
    );

    expect(templates.length === 4, `expected 4 templates, got ${templates.length}`);
    expect(instances.length === 2, `expected 2 instances, got ${instances.length}`);
    expect(bindings.length === 6, `expected 6 bindings, got ${bindings.length}`);

    for (const code of ["tpl_pho_phong", "tpl_nv_content", "tpl_nv_media", "tpl_nv_prompt"]) {
      expect(templates.some((row) => row.code === code), `missing template ${code}`);
    }

    expect(
      instances.some((row) => row.instanceCode === "mgr_pho_phong_A"),
      "missing instance mgr_pho_phong_A",
    );
    expect(
      instances.some((row) => row.instanceCode === "mgr_pho_phong_B"),
      "missing instance mgr_pho_phong_B",
    );

    for (const managerCode of ["mgr_pho_phong_A", "mgr_pho_phong_B"]) {
      for (const workerCode of ["tpl_nv_content", "tpl_nv_media", "tpl_nv_prompt"]) {
        expect(
          bindings.some(
            (row) => row.manager_code === managerCode && row.worker_code === workerCode,
          ),
          `missing binding ${managerCode} -> ${workerCode}`,
        );
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          migrationPath: path.relative(process.cwd(), seedMigrationPath),
          templates,
          instances,
          bindings,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
