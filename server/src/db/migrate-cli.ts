import { openDb, migrate } from "./db.js";
const d = openDb();
const ran = migrate(d);
console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Database is up to date");
