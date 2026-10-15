# Plan de migración a Supabase (nube sincronizada y privada)

> Pospuesto a propósito. El backup JSON (`src/backup.ts`) es el puente actual.
> Para arrancar: crear proyecto en supabase.com y elegir login (Google recomendado).

## Objetivo
Login + datos privados sincronizados multi-dispositivo, manteniendo la app local-first
(rápida y usable offline). RLS estricto: cada usuario solo ve lo suyo, sin compartir.

## Arquitectura
- **Supabase**: Postgres + Auth + RLS. Plan gratis (500 MB, 50k MAU) de sobra.
- **Frontend**: estático en Cloudflare Pages. Claves `anon` en `.env`
  (la seguridad la pone RLS, no la clave; `service_role` jamás sale del servidor).
- **Estado local** (zustand + localStorage) se conserva como caché; sync por encima.

## Esquema (todas las tablas con `user_id uuid references auth.users`)
```sql
projects   (id uuid pk, user_id, name text, icon text|null,
            created_at timestamptz, updated_at timestamptz)
cards      (id uuid pk, user_id, project_id fk, title, summary, content,
            color text, icon text|null, tags text[], x float, y float,
            type text, group_id uuid|null, deleted_at timestamptz|null,
            updated_at timestamptz)
connections(id uuid pk, user_id, project_id fk, source uuid, target uuid)
groups     (id uuid pk, user_id, project_id fk, name, color, x, y,
            width, height, locked bool)
codex_entries (id uuid pk, user_id, project_id fk, type text, name,
            aliases text[], color, notes)
revisions  (id uuid pk, user_id, project_id fk, card_id fk, summary,
            content, created_at timestamptz)
```
RLS en las 6: `create policy owner on <t> for all using (auth.uid() = user_id)`.
Índices en `(user_id, project_id)` y `cards(project_id)`.

## Sync (last-write-wins por fila)
1. `AuthGate`: sin sesión se muestra login (Google o magic link), no la app.
2. Pull al abrir proyecto; push con debounce ~2s (upsert por tabla con `updated_at`).
3. Offline: cola `outbox` en localStorage → flush al volver la red + badge online/offline.
4. Conflictos: gana `updated_at` mayor; avisar si se pisa algo más nuevo de otro dispositivo.
5. Migración: botón "Subir mis datos locales" (lee el estado zustand y hace upsert masivo).

## Fases (~2–4 días)
1. Proyecto Supabase + SQL + RLS + Auth + `supabase-js` + gate de login.
2. Capa sync (push/pull/outbox/LWW) + estados de conexión.
3. Migración local→nube + deploy en Pages + env + prueba en dos navegadores.
4. Colchón: conflictos, respaldo, docs.

## Pendiente del usuario
- [ ] Proyecto creado en Supabase + **URL + anon key**
- [ ] Login elegido: Google / email-magic-link
