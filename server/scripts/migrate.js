import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';

const db = await createDb();
const ran = await migrate(db);
console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
await db.close();
