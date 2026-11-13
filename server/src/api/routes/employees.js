import { createEmployee, getEmployee, listEmployees, nextEmployeeCode, updateEmployee } from '../../services/employees.js';
import { requireHr } from '../../services/access.js';

export default async function employeeRoutes(app) {
  app.get('/', async (req) => listEmployees(req.ctx, { departmentId: req.query.departmentId, status: req.query.status }));
  app.get('/next-code', async (req) => { requireHr(req.ctx); return { code: await nextEmployeeCode(req.ctx) }; });
  app.get('/:id', async (req) => getEmployee(req.ctx, req.params.id));
  app.post('/', async (req, reply) => reply.status(201).send(await createEmployee(req.ctx, req.body ?? {})));
  app.patch('/:id', async (req) => updateEmployee(req.ctx, req.params.id, req.body ?? {}));
}
