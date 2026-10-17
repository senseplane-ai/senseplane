// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Self-host CLI:
//   senseplane-admin create-account <name>                prints an account id and API key
//   senseplane-admin create-user <account_id> <email> [role]
//                                                         adds a console sign-in to the account (default role owner;
//                                                         a new email's password comes from SENSEPLANE_PASSWORD)
//   senseplane-admin reset-password <email>               sets a new password (from SENSEPLANE_PASSWORD)
import { createDb } from "./data/db.js";
import { DataAccess } from "./data/access.js";
import { createPasswordUser, hashPassword } from "./routes/auth.js";
import { ROLES, type Role } from "./roles.js";

const [command, ...args] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url, 1);
const data = new DataAccess(db);
try {
  if (command === "create-account") {
    const name = args.join(" ") || "Default account";
    const account = await data.accounts.create(name, process.env.RAW_RETENTION_DAYS ? Number(process.env.RAW_RETENTION_DAYS) : undefined);
    const key = await data.withAccount(account.id, (s) => s.apiKeys.create("cli"));
    console.log(JSON.stringify({ account_id: account.id, api_key: key.key }));
  } else if (command === "create-user" && (args.length === 2 || args.length === 3)) {
    const password = process.env.SENSEPLANE_PASSWORD ?? "";
    const role = (args[2] ?? "owner") as Role;
    if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(", ")}`);
    await createPasswordUser(data, args[0]!, args[1]!, password, role);
    console.log(JSON.stringify({ account_id: args[0], email: args[1]!.toLowerCase(), role }));
  } else if (command === "reset-password" && args.length === 1) {
    const password = process.env.SENSEPLANE_PASSWORD ?? "";
    if (password.length < 10) throw new Error("SENSEPLANE_PASSWORD must be at least 10 characters");
    const r = await data.db().updateTable("users").set({ password_hash: await hashPassword(password) }).where("email", "=", args[0]!.toLowerCase()).executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw new Error("no user with that email");
    console.log(JSON.stringify({ email: args[0]!.toLowerCase(), reset: true }));
  } else {
    console.error("usage: senseplane-admin create-account <name> | create-user <account_id> <email> [owner|admin|member|viewer] | reset-password <email>");
    process.exitCode = 2;
  }
} finally {
  await db.destroy();
}
