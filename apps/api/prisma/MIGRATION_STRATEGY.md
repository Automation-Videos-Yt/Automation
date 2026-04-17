# Prisma Migration Strategy

## Development

```bash
npm run prisma:migrate
npm run prisma:generate
```

## Production

```bash
npm --workspace apps/api run prisma:deploy
```

Rules:

- Never use `prisma db push` in production.
- Commit every generated migration under `apps/api/prisma/migrations/`.
- Run `prisma migrate deploy` before starting API instances.
- Regenerate Prisma Client after schema changes in CI/build images.
