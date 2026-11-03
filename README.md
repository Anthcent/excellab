# ExcelLab (GridLab)

Simulador de hoja de cálculo con apariencia de Excel en español, pensado para enseñar y practicar fórmulas, incluso desde el teléfono en horizontal. Además incluye un backend con **login de estudiantes, ejercicios y exámenes** (cronómetro, máximo de intentos, calificación automática en el servidor) y módulos para que el personal cree ejercicios y exámenes.

## Dos formas de usarlo

1. **Práctica libre, sin servidor y sin login**: abre `index.html` en el navegador. No necesita instalación. Los datos se guardan solo en tu navegador (`localStorage`).
2. **Con servidor** (login, ejercicios y exámenes): ver abajo.

## Ejecutar en local

Requiere Node 22 o superior.

```bash
npm install
npm run dev
```

Abre <http://localhost:3000>. Sin configurar nada, el servidor:

- usa una base de datos **PGlite** (Postgres real en WASM) guardada en `./data/pglite`;
- crea el administrador `admin@excellab.local` / `admin12345` (solo en desarrollo; en producción se exige `ADMIN_PASSWORD`);
- crea **un examen demo** publicado con 4 ejercicios (SUMA, SI, BUSCARV, CONTAR.SI) para probar el flujo completo.

Otros comandos:

| Comando | Qué hace |
| --- | --- |
| `npm run build:site` | Genera `index.html`, `public/index.html` y `gridlab.html` desde `src/`. |
| `npm run build` | Lo anterior + compila el servidor (`server/dist`). |
| `npm start` | Ejecuta el servidor compilado (`node server/dist/main.js`). |
| `npm test` | Pruebas (motor, aleatoriedad y API completa sobre PGlite en memoria; no necesitan variables de entorno). |
| `npm run typecheck` | Revisa los tipos del servidor. |

Para probar la práctica libre en un teléfono de la misma red Wi-Fi puedes usar el propio servidor: abre `http://IP-DE-LA-PC:3000` (o sirve la carpeta con `python -m http.server`).

## Desplegar en tu servidor (Docker + Postgres)

```bash
cp .env.example .env      # edita al menos POSTGRES_PASSWORD, ADMIN_EMAIL y ADMIN_PASSWORD
docker compose up -d --build
```

Levanta dos servicios: `app` (el sitio y la API en el puerto `APP_PORT`, 3000 por defecto) y `postgres` (con el volumen `pgdata`). Las migraciones se aplican solas al arrancar y el administrador se crea en el primer arranque.

- Ponlo detrás de un proxy con HTTPS (Caddy, Nginx, Traefik…). Si lo sirves por `http` plano (solo pruebas) pon `COOKIE_SECURE=false`, o las cookies de sesión no se guardarán.
- Respaldo: `docker compose exec postgres pg_dump -U excellab excellab > respaldo.sql`.

### Variables de entorno

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `DATABASE_URL` | vacío | Conexión a Postgres. **Vacío = PGlite embebido** (desarrollo/pruebas). Docker Compose la define sola. |
| `PGLITE_DIR` | `./data/pglite` | Carpeta de PGlite cuando `DATABASE_URL` está vacío. |
| `ADMIN_EMAIL` | `admin@excellab.local` | Correo del administrador que se crea al arrancar si no existe. |
| `ADMIN_PASSWORD` | solo en desarrollo: `admin12345` | Contraseña inicial (mínimo 8). **Obligatoria en producción** (`NODE_ENV=production`). |
| `COOKIE_SECURE` | `true` en producción, `false` en desarrollo | Cookie de sesión solo por HTTPS. |
| `PUBLIC_ORIGIN` | vacío | Origen público extra permitido para peticiones que modifican datos (las del mismo host siempre se permiten). |
| `SESSION_TTL_DAYS` | `30` | Duración de la sesión. |
| `PORT` | `3000` | Puerto HTTP. |
| `SEED_DEMO` | `true` | Crea el examen demo una sola vez (queda marcado en la base de datos). |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `APP_PORT` | ver `.env.example` | Solo para `docker-compose.yml`. |

## Cómo funciona

- **Una sola app**: Fastify sirve la API bajo `/api` y el sitio estático desde `public/`, en el mismo origen (las cookies funcionan sin CORS).
- **Calificación en el servidor**: el servidor recalcula el libro del estudiante con el **mismo motor** que usa el navegador (`src/engine.js`). Nunca confía en valores calculados que envíe el cliente. Los estudiantes nunca reciben las verificaciones ni los valores esperados.
- **Cronómetro del servidor**: cada intento tiene `deadline_at`. Pasado el plazo (más 5 s de gracia) cualquier petición cierra el intento y califica lo último guardado; además un barrido cada minuto cierra los abandonados.
- **Intentos**: máximo configurable (2 por defecto), un solo intento en curso por examen y estudiante. Cada intento sortea y ordena los ejercicios con una semilla nueva; si el banco es mayor que `pick_count`, prefiere ejercicios que el estudiante no vio antes.
- **Nota**: `grade = porcentaje / 100 × scale` (escala por examen, 20 por defecto). La nota del examen sigue `grade_policy`: `best` (mejor intento) o `last` (último). Aprueba con `pass_percent` (60 por defecto).

### Verificaciones de un ejercicio (`checks`)

Cada una lleva `points` (se reescalan proporcionalmente a los puntos del ejercicio) y un `label` opcional que ve el estudiante (no pongas ahí la respuesta).

```jsonc
{ "type": "cell_value", "sheet": "Ventas", "cell": "B8", "expected": 600, "tolerance": 0.01, "ignoreCase": false, "requireFormula": true, "points": 7 }
{ "type": "cell_formula_uses", "cell": "B8", "functions": ["SUMA"], "points": 3 }          // nombres en español
{ "type": "range_values", "range": "C2:C5", "expected": [["Aprobado"], ["Reprobado"], ["Aprobado"], ["Reprobado"]], "points": 5 }
```

`sheet` es opcional (por defecto, la primera hoja).

## API (JSON)

Errores: `{ "error": { "code": "...", "message": "...", "fields"?: [...] } }`. Las peticiones que modifican datos exigen el mismo origen.

**Autenticación** (cookie de sesión `gl_session`, httpOnly)

| Método y ruta | Descripción |
| --- | --- |
| `POST /api/auth/register` `{name,email,password}` | Crea un estudiante (201) e inicia sesión. |
| `POST /api/auth/login` `{email,password}` | Inicia sesión. Limitado a 5 intentos/min por IP+correo. |
| `POST /api/auth/logout` | Cierra la sesión (204). |
| `GET /api/auth/me` | Usuario actual `{id,name,email,role,createdAt}`; `role` es `student` o `admin`. |

**Estudiante**

| Método y ruta | Descripción |
| --- | --- |
| `GET /api/exams` | Exámenes publicados con mis intentos, intentos restantes y mi resultado. |
| `GET /api/exams/:id` | Título, instrucciones, duración y reglas. **No** incluye los ejercicios. |
| `POST /api/exams/:id/attempts` `{accepted:true}` | Inicia un intento (201) o devuelve el que está en curso (200, `resumed:true`). Sin `accepted:true`: 400 `INSTRUCTIONS_NOT_ACCEPTED`. |
| `GET /api/attempts/:id` | Estado: `deadlineAt`, `serverNow`, ejercicios (título, instrucciones, puntos, libro inicial o borrador, nota si ya se envió). |
| `PUT /api/attempts/:id/exercises/:exerciseId/draft` `{workbook}` | Guarda el borrador. |
| `POST /api/attempts/:id/exercises/:exerciseId/submit` `{workbook}` | Envía y califica el ejercicio al instante (queda bloqueado). |
| `POST /api/attempts/:id/finish` | Califica lo pendiente desde los borradores y cierra el intento. |
| `GET /api/me/results` | Mis resultados por examen. |

**Personal (solo `admin`)**

| Método y ruta | Descripción |
| --- | --- |
| `GET/POST /api/admin/exercises`, `GET/PUT/DELETE /api/admin/exercises/:id` | CRUD de ejercicios (con `checks`). DELETE devuelve 409 si ya se usó en intentos. |
| `POST /api/admin/exercises/:id/preview-grade` `{workbook, checks?, points?}` | Prueba el calificador (ve el detalle completo). |
| `GET/POST /api/admin/exams`, `GET/PUT/DELETE /api/admin/exams/:id` | CRUD de exámenes. DELETE devuelve 409 si hay intentos. |
| `PUT /api/admin/exams/:id/exercises` `{exerciseIds[]}` | Define el banco de ejercicios y su orden. |
| `GET /api/admin/results?examId=&userId=` | Intentos y resumen por estudiante/examen. |
| `GET /api/admin/attempts/:id` | Detalle de un intento: respuestas, libros y resultado de cada verificación. |

El libro (`workbook`) tiene el formato de la sección 3 de `GUIA-DESARROLLO.md`. El servidor lo valida y limpia (máx. 20 hojas, 8000 celdas, ~1 MB por petición).

## Estructura

| Ruta | Contenido |
| --- | --- |
| `src/` | Código del sitio: `engine.js` (motor sin DOM), `app.js` (interfaz), `style.css`, `body.html`, `template.html`. |
| `scripts/build.mjs` | Genera `index.html`, `public/index.html` y `gridlab.html`. |
| `server/src/` | API en TypeScript: `auth/`, `attempts/` (alumno), `exercises/` y `exams/` (personal), `grid/` (motor + verificaciones), `db/`, `seed/`. |
| `server/migrations/` | Migraciones SQL numeradas. |
| `server/test/` | Pruebas con `node:test`. |
| `GUIA-DESARROLLO.md` | Cómo está construido el simulador y cómo habilitar botones simulados. |

Los archivos `index.html` y `gridlab.html` de la raíz son **generados**: no los edites, cambia `src/` y ejecuta `npm run build:site`.
