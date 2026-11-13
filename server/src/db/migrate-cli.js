import { createDb } from './index.js';
import { migrate } from './migrate.js';

const db = await createDb();
const ran = await migrate(db);
console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
await db.close();
