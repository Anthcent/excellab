# Plan de integración ExcelLab ↔ Hexper (taller)

Documento de traspaso para continuar en otra sesión de Claude. Estado al 2026-11-03.

## 1. Estado actual

### ExcelLab (`R:\IMAGENES\TALLER\excellab`, https://github.com/Anthcent/excellab, rama `main`)
- Todo subido: último commit `a771c81`. Árbol limpio.
- Frontend: JS vanilla, build en un solo HTML (`scripts/build.mjs`). Motor puro `GridEngine` compartido con el servidor.
- Backend: Node ≥22, Fastify 5, TypeScript, zod, argon2, cookie `gl_session`, Postgres (`pg`) en producción o PGlite embebido en local.
- Roles: `student | teacher | admin`. Constructor de exámenes completo, banco de ejercicios, usuarios, estadísticas, CSV.
- Examen: temporizador del servidor, 2 intentos (más extras), ejercicios sorteados por intento, nota automática por ejercicio, resultados guardados.
- Pestaña de instrucciones en el borde izquierdo (semitransparente al ocultarse).
- 190 tests pasando, `tsc` limpio.
- Local: `npm run dev` en http://localhost:3000. Admin `admin@excellab.local` / `admin12345`; profesor `profesor@excellab.local` / `profesor12345`. La base local está en `data/` (ignorada por git).
- Si el navegador no muestra cambios: Ctrl+Shift+R.

### Sin verificar todavía
- Adaptador real de Postgres, `Dockerfile` y `docker-compose` (no hay Docker/Postgres local).
- Teléfonos reales, accesibilidad, estados de error y carga, tablets.
- La pestaña de instrucciones tapa los primeros encabezados de fila de la hoja.
- Las instrucciones de cada ejercicio son texto plano; las del examen aceptan formato.
- `lab.js` parchea `Element.prototype.replaceChildren` para ignorar nulos (conviene limpiarlo).
- Los intentos extra solo se resuelven para alumnos de la lista de acceso o que ya rindieron.

## 2. Hexper (taller) — es PRODUCCIÓN

- Repo: https://github.com/Anthcent/hexperlab, sitio: https://taller.hexper.space/
- **Regla del usuario: no tocar `main`. Dokploy despliega `main`.** Trabajar en la rama `feat/excellab-practice` y el usuario hace el merge.
- No pushear a `main` bajo ningún concepto. Se pueden correr los tests del servidor de Hexper.
- Stack: Vite + React (front) servido por nginx; API Fastify (`server/`), Postgres 17; Dokploy + Traefik; red `dokploy-network`. Volúmenes `pgdata` y `uploads`.
- Migraciones SQL (`server/migrations/001..013`) se aplican solas al arrancar la API, con advisory lock y transacción por archivo. Si una falla, el contenedor cae al arrancar.
- Sesión: cookie `hx_session` (httpOnly, secure, sameSite=lax, **sin dominio**, es decir host-only), token hasheado en tabla `sessions`. Argon2id. Tabla `users`: `id uuid, name, email, password_hash, role ('user'|'admin'), joined_at`.
- Endpoints: `POST /api/auth/register|login|logout`, `GET /api/auth/me`. Las peticiones no-GET exigen `Origin == PUBLIC_ORIGIN` y rechazan `Sec-Fetch-Site: cross-site`.
- No existe CORS, claves de API ni webhooks.
- Talleres: tabla `workshops` (id texto, title, summary, description, status, lifecycle, agenda jsonb, etc.), `materials`, `registrations`. Validación en `server/src/workshops/schema.ts` (`workshopInput`), más `repo.ts` y `routes.ts` (no leídos aún).
- Vista del alumno: `WorkshopDetailPage` en `src/pages/UserPages.tsx:171` (ruta en `src/App.tsx:304`). Editor admin: `src/pages/WorkshopEditorPage.tsx` y `src/pages/workshop-editor/`.

## 3. Objetivo de la integración

Que un taller pueda activar una "Práctica" o "Examen" de ExcelLab:

1. Un taller (nuevo o existente) tiene un campo opcional que lo vincula a una práctica/examen de ExcelLab. El admin lo activa desde el editor del taller.
2. En la vista del taller aparece un banner pequeño ("Práctica" / "Examen") que abre ExcelLab en otro enlace, propio de ese taller.
3. Si el alumno tiene sesión en el taller: entra a ExcelLab con su cuenta del taller, sin segunda contraseña, y sus resultados quedan guardados en ExcelLab **y** se ven en la página del taller.
4. Si no tiene sesión del taller: entra con un usuario propio de ExcelLab y los resultados quedan solo en ExcelLab.

## 4. Diseño propuesto

- **Dominio:** ExcelLab en un subdominio (`practica.hexper.space`, recomendado). Cada app conserva su cookie. Pendiente de confirmar con el usuario.
- **SSO por token firmado** (las cookies son host-only, no se pueden compartir):
  - Hexper: endpoint nuevo con sesión activa, p. ej. `POST /api/practice/launch`, que devuelve un token firmado (HMAC/JWT, vida de ~60 s, un solo uso) con `sub` (id de usuario), nombre, email, id de taller e id de examen.
  - ExcelLab: endpoint nuevo que valida el token con el secreto compartido, crea o vincula el usuario (`external_id` / `external_source`) y abre su sesión `gl_session`.
  - Secretos y URLs en variables de entorno de ambos lados.
- **Resultados hacia el taller:** Hexper consulta a ExcelLab de servidor a servidor (clave compartida en una cabecera). Sin CORS. Alternativa: ExcelLab empuja un webhook al terminar el intento.
- **Cambios en Hexper (solo aditivos):**
  - Migración `014_*.sql`: columna nullable en `workshops` (por ejemplo `practice_exam_id text`) y, si hace falta, una tabla de vínculos usuario ↔ resultados. Los talleres existentes no cambian.
  - Campo en `workshopInput` (zod), `repo.ts` y `routes.ts`.
  - Editor admin: control para asignar/activar la práctica.
  - Banner en `WorkshopDetailPage` solo si el campo tiene valor.
  - Tests del servidor para el endpoint de lanzamiento.
- **Cambios en ExcelLab:**
  - Migración: columnas de vínculo externo en `users` (nullable).
  - Endpoint de canje del token y endpoint de resultados para Hexper (con clave).
  - Aviso en el login: "Entra con tu cuenta del taller" cuando se llega desde un taller.
  - Parámetro `?exam=<id>` para abrir un examen directo.

## 5. Orden de trabajo sugerido

1. Confirmar con el usuario el dominio y cómo se despliega.
2. ExcelLab: vínculo externo + canje de token + endpoint de resultados + tests. Commit a `main` de excellab (se permite, no es producción del taller).
3. Hexper, **en rama `feat/excellab-practice`**: migración 014, endpoint de lanzamiento, campo en editor, banner, tests. Correr `npm test` en `server/` y `tsc`.
4. Probar la migración contra una copia de la estructura de la base antes de que el usuario haga el merge.
5. Avisar al usuario con el resumen de cambios para que haga el merge él mismo.
6. Despliegue de ExcelLab en el servidor del usuario (Dokploy o docker-compose + Postgres). Probar `Dockerfile` y `docker-compose`. Definir secretos compartidos.
7. Pulido: puntos de "Sin verificar" de la sección 1.

## 6. Reglas del usuario

- Responder en español (voseo rioplatense), respuestas cortas, una pregunta por vez y esperar.
- Código, comentarios, commits y UI en inglés (el texto de UI de ExcelLab y Hexper está en español porque así es el producto).
- Commits convencionales, **sin** `Co-Authored-By` ni atribución de IA.
- Herramientas: nada de `cat/grep/find/sed/ls`; usar `bat/rg/fd/sd/eza` o las herramientas dedicadas.
- Verificar afirmaciones antes de darlas por ciertas.
- Primero que todo funcione, el pulido después.
- En Git Bash en Windows: `MSYS_NO_PATHCONV=1` para rutas con `#`.
