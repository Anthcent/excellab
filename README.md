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
- crea un profesor de desarrollo `profesor@excellab.local` / `profesor12345` (solo en desarrollo; no se crea en producción);
- crea **un examen demo** publicado con un bloque («Funciones básicas») de 4 ejercicios (SUMA, SI, BUSCARV, CONTAR.SI) para probar el flujo completo.

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
- **Intentos**: máximo configurable (2 por defecto), un solo intento en curso por examen y estudiante. Cada intento sortea los ejercicios **por bloque** con una semilla nueva; si el banco de un bloque es mayor que su `pickCount`, prefiere ejercicios que el estudiante no vio antes (ver «Modelo de exámenes»).
- **Nota**: `grade = porcentaje / 100 × scale` (escala por examen, 20 por defecto). La nota del examen sigue `grade_policy`: `best` (mejor intento) o `last` (último). Aprueba con `pass_percent` (60 por defecto).

### Verificaciones de un ejercicio (`checks`)

Cada una lleva `points` (se reescalan proporcionalmente a los puntos del ejercicio) y un `label` opcional que ve el estudiante (no pongas ahí la respuesta).

```jsonc
{ "type": "cell_value", "sheet": "Ventas", "cell": "B8", "expected": 600, "tolerance": 0.01, "ignoreCase": false, "requireFormula": true, "points": 7 }
{ "type": "cell_formula_uses", "cell": "B8", "functions": ["SUMA"], "points": 3 }          // nombres en español
{ "type": "range_values", "range": "C2:C5", "expected": [["Aprobado"], ["Reprobado"], ["Aprobado"], ["Reprobado"]], "points": 5 }
```

`sheet` es opcional (por defecto, la primera hoja).

## Roles

| Rol | Cómo se obtiene | Qué puede hacer |
| --- | --- | --- |
| `student` (estudiante) | Registro público (`POST /api/auth/register` siempre crea estudiantes) o un administrador. | Hacer exámenes, ver sus resultados. |
| `teacher` (profesor) | Solo lo crea un administrador. | Todo lo de estudiante, más crear y editar **solo sus propios** ejercicios y exámenes, ver los resultados, el análisis y los CSV **de sus exámenes**. Lo ajeno responde 404. |
| `admin` (administrador) | Se crea al arrancar (`ADMIN_EMAIL`) o lo promueve otro administrador. | Todo: ver y editar el contenido de todos (filtrar por propietario y reasignarlo), gestionar usuarios, ver todos los resultados. |

Guardas: `requireUser` (sesión), `requireStaff` (`teacher` o `admin`) para la autoría de ejercicios y exámenes, resultados, estadísticas y CSV, y `requireAdmin` para la gestión de usuarios.

| Ruta (prefijo `/api`) | Anónimo | Estudiante | Profesor | Admin |
| --- | --- | --- | --- | --- |
| `/auth/register`, `/auth/login` | sí | sí | sí | sí |
| `/auth/me`, `/auth/profile`, `/auth/change-password`, `/auth/logout` | 401 | sí | sí | sí |
| `/exams*`, `/attempts*`, `/me/results` | 401 | sí | sí | sí |
| `/admin/exercises*`, `/admin/exams*` (autoría, bloques, acceso, intentos extra, duplicar, vista previa del sorteo) | 401 | 403 | solo lo propio (404 si es ajeno) | todo |
| `/admin/results`, `/admin/results.csv`, `/admin/attempts/:id`, `/admin/exams/:id/analytics`, `/admin/exams/:id/results.csv`, `/admin/stats` | 401 | 403 | solo sus exámenes | todo |
| `/admin/users*` | 401 | 403 | 403 | sí |

Una cuenta con `mustChangePassword: true` (creada por un administrador o con la contraseña restablecida) solo puede llamar a `/auth/me`, `/auth/logout` y `/auth/change-password`; el resto responde `403 PASSWORD_CHANGE_REQUIRED`. Una cuenta desactivada no puede ingresar (`403 ACCOUNT_DISABLED`, solo se revela si la contraseña es correcta) y sus sesiones se revocan.

## API (JSON)

Errores: `{ "error": { "code": "...", "message": "...", "fields"?: [...] } }`. Las peticiones que modifican datos exigen el mismo origen. Las listas de ejercicios y exámenes devuelven un arreglo simple; con `page` y/o `pageSize` (1-100, 25 por defecto) devuelven `{ items, total, page, pageSize }`. Las listas de usuarios siempre devuelven esa forma.

**Autenticación** (cookie de sesión `gl_session`, httpOnly)

| Método y ruta | Descripción |
| --- | --- |
| `POST /api/auth/register` `{name,email,password}` | Crea un estudiante (201) e inicia sesión. |
| `POST /api/auth/login` `{email,password}` | Inicia sesión. Limitado a 5 intentos/min por IP+correo. |
| `POST /api/auth/logout` | Cierra la sesión (204). |
| `GET /api/auth/me` | `{id,name,email,role,createdAt,mustChangePassword}`; `role` es `student`, `teacher` o `admin`. |
| `GET /api/auth/profile`, `PATCH /api/auth/profile` `{name}` | Lee o cambia mi nombre. |
| `POST /api/auth/change-password` `{currentPassword,newPassword}` | Cambia la contraseña (mínimo 8), quita `mustChangePassword` y cierra las otras sesiones. Errores: `WRONG_CURRENT_PASSWORD`, `PASSWORD_UNCHANGED`. |

**Estudiante**

| Método y ruta | Descripción |
| --- | --- |
| `GET /api/exams` | Exámenes publicados visibles para mí (los restringidos solo si estoy en la lista o ya participé). Cada tarjeta: los campos de siempre más `description`, `requiresCode`, `extraAttempts`, `feedbackMode`, `resultMode`, `allowReview`, `resultsVisible`. `maxAttempts` ya incluye los intentos extra. `result` y las notas de `attempts` son `null` mientras `resultsVisible` sea `false`. |
| `GET /api/exams/:id` | La tarjeta más `instructions`. **No** incluye los ejercicios. |
| `POST /api/exams/:id/attempts` `{accepted:true, accessCode?}` | Inicia un intento (201) o devuelve el que está en curso (200, `resumed:true`; no pide el código). Errores: `INSTRUCTIONS_NOT_ACCEPTED`, `ACCESS_CODE_REQUIRED`, `INVALID_ACCESS_CODE` (403, máx. 10 comprobaciones/min), `NO_ATTEMPTS_LEFT`, `EXAM_NOT_OPEN`, `EXAM_CLOSED`, `EXAM_POOL_TOO_SMALL` y `EXAM_EMPTY` (409). Un examen restringido en el que no estoy responde 404. |
| `GET /api/attempts/:id` | Estado del intento (ver abajo). |
| `PUT /api/attempts/:id/exercises/:exerciseId/draft` `{workbook}` | Guarda el borrador. |
| `POST /api/attempts/:id/exercises/:exerciseId/submit` `{workbook}` | Envía y califica el ejercicio. Respuesta `{exerciseId, feedbackMode, score, maxScore, results, progress}`: `score` es `null` con `feedbackMode:"none"`; `results` solo viene con `"details"`. |
| `POST /api/attempts/:id/finish` | Califica lo pendiente y cierra el intento; devuelve la misma vista que `GET /api/attempts/:id`. |
| `GET /api/me/results` | Mis resultados por examen (añade `resultMode`, `resultsVisible`; las notas son `null` si no se pueden ver). |

Vista del intento: `{id, examId, examTitle, number, status, startedAt, deadlineAt, serverNow, durationMinutes, scale, passPercent, feedbackMode, resultMode, allowReview, resultsVisible, scorePercent, grade, passed, exercises:[{id, position, block, title, instructions, points, workbook, submitted, score, maxScore, results}]}`. `block` es el título de la sección (`null` en intentos anteriores a los bloques). `points` ya incluye `points_override`. Con el intento en curso: `score` y `results` siguen `feedbackMode`. Con el intento terminado: `scorePercent`, `grade` y `passed` solo se ven si `resultsVisible`; `score`/`results` por ejercicio además requieren `feedbackMode` o `allowReview`; y `workbook` es `null` salvo que `allowReview` sea `true`.

**Personal: ejercicios** (`teacher` y `admin`)

| Método y ruta | Descripción |
| --- | --- |
| `GET /api/admin/exercises?q=&difficulty=&tag=&status=&owner=&page=&pageSize=` | Lista. `q` busca en título y etiquetas. `owner` solo lo respeta el admin. Cada fila: `id,title,points,status,difficulty,tags,estimatedMinutes,category,ownerId,ownerName,checkCount,checksCount,examCount,attemptsCount,createdAt,updatedAt`. |
| `POST /api/admin/exercises` | Crea (201). Campos: `title, instructions, points, workbook, checks, status` y `difficulty` (`easy`/`medium`/`hard`, por defecto `medium`), `tags` (hasta 10 textos de 30 caracteres, se normalizan a minúsculas y sin repetidos), `estimatedMinutes` (entero o `null`), `category` (texto de hasta 60 o `null`). El propietario es quien crea. |
| `GET/PUT/PATCH/DELETE /api/admin/exercises/:id` | Detalle (con `workbook`, `checks`, `ownerId`), edición parcial (el admin puede enviar `ownerId` de un profesor o admin activo; si no, 403/`INVALID_OWNER`) y borrado (409 `EXERCISE_IN_USE` si ya se usó en intentos). |
| `POST /api/admin/exercises/:id/duplicate` | Copia como borrador, título + ` (copia)`, propietario quien llama (201). |
| `GET /api/admin/exercises/export?ids=a,b` o `POST /api/admin/exercises/export` `{ids}` | JSON `{format:"excellab.exercises", version:1, exportedAt, exercises:[…]}` sin ids; solo los que puedo ver. |
| `POST /api/admin/exercises/import` `[…]` o `{exercises:[…]}` | Importa hasta 100 ejercicios como **borradores** míos, con la misma validación. Respuesta `{imported, failed, results:[{index, ok, id?, title?, error?:{code,message,fields?}}]}`. |
| `POST /api/admin/exercises/:id/preview-grade` `{workbook, checks?, points?}` | Prueba el calificador (ve el detalle completo). |

**Personal: exámenes** (`teacher` y `admin`)

| Método y ruta | Descripción |
| --- | --- |
| `GET /api/admin/exams?q=&status=&owner=&page=&pageSize=` | Lista con `exerciseCount, blockCount, attemptCount, accessCount, ownerId, ownerName`. |
| `POST /api/admin/exams` | Crea (201). Acepta los ajustes de la tabla de abajo y, opcionalmente, `blocks` (ver `PUT …/blocks`) o la forma antigua `exerciseIds`. |
| `GET /api/admin/exams/:id` | Todos los campos y ajustes (incluido `accessCode`), `blocks:[{id,position,title,pickCount,shuffle,exercises:[{exerciseId,title,points,pointsOverride,effectivePoints,status,position}]}]` y `exercises` (lista plana antigua). |
| `PUT/PATCH /api/admin/exams/:id` | Edición parcial. Incluye `ownerId` (solo admin), `blocks`, `exerciseIds` y `pickCount` (obsoletos, ver abajo). Si el examen queda publicado se valida la publicación. |
| `PUT /api/admin/exams/:id/blocks` `{blocks:[{id?, title, pickCount, shuffle, exercises:[{exerciseId, pointsOverride?}]}]}` | Reemplaza **toda** la estructura en una transacción (hasta 20 bloques; el `id` conserva el bloque). Errores: `DUPLICATE_EXERCISES`, `UNKNOWN_EXERCISE` (no existe o, para un profesor, es ajeno), `EXERCISE_NOT_PUBLISHED`, `PICK_EXCEEDS_POOL`. |
| `PUT /api/admin/exams/:id/exercises` `{exerciseIds}` | Comodidad: deja **un solo bloque** con esos ejercicios (conserva título, `shuffle` y selección del primero; `Ejercicios` si no había). |
| `POST /api/admin/exams/:id/draw-preview` `{seed?}` | Simula un sorteo sin crear intento: `{seed, exerciseCount, totalPoints, blocks:[{title,pickCount,poolSize,points,exercises:[{id,title,points}]}]}`. |
| `POST /api/admin/exams/:id/duplicate` | Copia ajustes y bloques como borrador del que llama; sin código ni lista de acceso (201). |
| `GET/PUT /api/admin/exams/:id/access` | `PUT {emails:[…], restricted?}` reemplaza la lista y responde `{restricted, matched:[{userId,name,email}], unknown:[emails]}` (solo cuentan los correos de estudiantes). `GET` responde `{restricted, entries:[…]}`. |
| `POST /api/admin/exams/:id/grant-attempt` `{userId, extra:1..5, reason?}` | Intentos extra para un estudiante (201, con `effectiveMaxAttempts`). `GET …/overrides` (o `GET …/grant-attempt`) los lista; `DELETE …/overrides/:overrideId` revoca. |
| `DELETE /api/admin/exams/:id` | 409 `EXAM_IN_USE` si hay intentos. |

**Personal: resultados, estadísticas y exportación** (`teacher` y `admin`; el profesor solo ve sus exámenes)

| Método y ruta | Descripción |
| --- | --- |
| `GET /api/admin/results?examId=&userId=` | `{attempts, summary}`; cada intento añade `passPercent` y `passed`. |
| `GET /api/admin/attempts/:id` | Detalle: respuestas, libros, resultado de cada verificación y `block` por ejercicio. |
| `GET /api/admin/stats` | `{scope:"all"\|"own", counts:{students,teachers,exercises:{draft,published,total},exams:{…},attempts:{total,last7Days,last30Days,inProgress}}, averageGradePercent, passRate, attemptsPerDay:[14 × {date,count}], topExams:[{examId,title,attempts}], recentAttempts:[10 × {id,studentName,studentEmail,examId,examTitle,status,scorePercent,grade,scale,passed,startedAt,submittedAt}]}`. Para un profesor `teachers` es `null` y `students` cuenta quienes intentaron sus exámenes. |
| `GET /api/admin/exams/:id/analytics` | `{exam, attemptsCount, finishedCount, inProgressCount, uniqueStudents, averagePercent, passRate, averageCompletionSeconds, distribution:[10 × {from,to,count}], exercises:[{exerciseId,title,timesDrawn,gradedCount,averagePercent,fullMarksShare}], students:[{userId,name,email,attemptsUsed,bestGrade,bestPercent,passed,lastAttemptAt}]}`. |
| `GET /api/admin/results.csv?examId=&userId=`, `GET /api/admin/exams/:id/results.csv` | CSV UTF-8 con BOM, separador `;`, decimales con coma y encabezado `Estudiante;Correo;Examen;Intento;Estado;Porcentaje;Nota;Escala;Aprobado;Inicio;Entrega`. |

**Personal: usuarios** (solo `admin`)

| Método y ruta | Descripción |
| --- | --- |
| `GET /api/admin/users?role=&q=&active=&page=&pageSize=` | `{items:[{id,name,email,role,active,mustChangePassword,createdAt}], total, page, pageSize}`. |
| `POST /api/admin/users` `{name,email,password,role,mustChangePassword?}` | Crea una cuenta con contraseña temporal (`mustChangePassword` es `true` por defecto). 409 `EMAIL_TAKEN`. |
| `PATCH /api/admin/users/:id` `{name?,role?,active?}` | Un administrador no puede cambiar su propio rol ni desactivarse (409 `CANNOT_MODIFY_SELF`) y nunca queda el sistema sin administradores activos (409 `LAST_ADMIN`). Desactivar revoca las sesiones. |
| `POST /api/admin/users/:id/reset-password` `{password}` | Contraseña temporal nueva (204): exige cambiarla al ingresar y revoca las sesiones. Para la propia, `USE_CHANGE_PASSWORD`. |

El libro (`workbook`) tiene el formato de la sección 3 de `GUIA-DESARROLLO.md`. El servidor lo valida y limpia (máx. 20 hojas, 8000 celdas, ~1 MB por petición).

## Modelo de exámenes

Un examen se compone de **bloques** (secciones). Cada bloque tiene `title`, `pickCount` (cuántos ejercicios se sortean de su banco; `null` = todos), `shuffle` (mezclar los sorteados dentro del bloque) y una lista ordenada de ejercicios, cada uno con un `pointsOverride` opcional. Un ejercicio solo puede estar una vez por examen. En cada intento:

1. Se genera una semilla nueva y, **por bloque**, se eligen `pickCount` ejercicios *publicados* de su banco, prefiriendo los que el estudiante no vio en intentos anteriores del mismo examen. Si el banco publicado de un bloque es menor que su `pickCount` el inicio falla con `409 EXAM_POOL_TOO_SMALL`; un bloque de "todos" sin ejercicios publicados se omite; sin ejercicios en ningún bloque, `409 EXAM_EMPTY`.
2. Dentro del bloque se mezclan solo si `shuffle`; si no, siguen el orden del bloque.
3. Los bloques siguen su orden (`position`), salvo que el examen tenga `shuffleBlocks`.
4. El intento guarda la lista ordenada (`exercise_ids`) y una instantánea por ejercicio (`exercise_meta`: título del bloque y `pointsOverride`). Cambiar el examen después no altera intentos ya iniciados.

Con `pointsOverride`, los puntos del ejercicio en ese examen son el override y los puntos de cada verificación se reescalan proporcionalmente; `maxScore`, porcentaje y nota usan esos valores. `exams.pick_count` está **obsoleto** (se conserva solo como espejo del único bloque de un examen con un bloque; la API antigua `pickCount` y `exerciseIds` sigue funcionando sobre un bloque por defecto).

Publicar exige al menos un bloque con un ejercicio publicado y que ningún `pickCount` supere los ejercicios publicados de su bloque (`EXAM_EMPTY`, `PICK_EXCEEDS_POOL`).

### Ajustes del examen

| Ajuste | Valores (por defecto) | Efecto |
| --- | --- | --- |
| `title`, `description` (≤ 500), `instructions` | texto | Lo que ve el estudiante en la tarjeta y en las instrucciones. |
| `durationMinutes` | 1-600 | Plazo del intento, contado por el servidor. |
| `maxAttempts` | 1-20 (2) | Intentos por estudiante; las concesiones de `grant-attempt` se suman. |
| `scale`, `passPercent`, `gradePolicy` | 20, 60, `best`/`last` | Nota = porcentaje/100 × escala; aprueba con `passPercent`; cuenta el mejor o el último intento. |
| `availableFrom`, `availableUntil` | fecha o `null` | Ventana en la que se puede **iniciar** un intento (`EXAM_NOT_OPEN`, `EXAM_CLOSED`). |
| `shuffleBlocks` | `false` | Mezcla el orden de los bloques en cada intento. |
| `feedbackMode` | `none`, `score`, `details` (`details`) | Qué ve el estudiante al enviar cada ejercicio: nada, solo el puntaje, o puntaje y resultado de cada verificación. |
| `resultMode` | `immediate`, `after_close`, `hidden` (`immediate`) | Cuándo se revela la nota **final** al estudiante (ver abajo). |
| `allowReview` | `false` | Al terminar, el estudiante puede ver sus libros enviados con puntaje y resultado por verificación de cada ejercicio (aunque `feedbackMode` sea `none`), siempre que la nota ya sea visible. |
| `accessCode` | texto ≤ 64 o `null` | Si existe, `POST …/attempts` debe enviar `accessCode` (comparación en tiempo constante). El estudiante solo ve `requiresCode`. |
| `restricted` | `false` | Si es `true`, solo los estudiantes de la lista (`…/access`) ven e inician el examen. |

**Semántica de `resultMode`.** `immediate`: la nota y el porcentaje se ven en cuanto el intento termina. `hidden`: el estudiante nunca ve notas ni resultados por ejercicio (solo el personal); `finish` y la vista del intento devuelven `scorePercent`, `grade` y `passed` en `null` y `resultsVisible:false`. `after_close`: se ocultan hasta que ocurra lo primero de (a) pasó `availableUntil`, o (b) el estudiante agotó sus intentos (contando los extra) y no tiene uno en curso. Un examen `after_close` sin `availableUntil` solo se revela al agotar los intentos. Mientras está oculta, `result` es `null` en la tarjeta y en `/api/me/results`.

## Migraciones

`server/migrations/*.sql` se aplican en orden al arrancar, cada una en su transacción (`schema_migrations`). **Nunca edites una ya publicada**: añade la siguiente. La `002_roles_blocks_settings.sql` es aditiva y actualiza en sitio una base creada con la `001`:

- `users`: rol `teacher`, `active` (por defecto `true`) y `must_change_password` (por defecto `false`).
- `exercises` y `exams`: `owner_id` (se rellena con `created_by` o, si falta, con el primer administrador); ejercicios con `difficulty`, `tags`, `estimated_minutes`, `category`; exámenes con `description`, `shuffle_blocks`, `feedback_mode`, `result_mode`, `allow_review`, `access_code`, `restricted`.
- `exam_blocks` y `exam_block_exercises`: cada examen con ejercicios recibe **un bloque `Ejercicios`** con su orden y su `pick_count` anteriores (un `pick_count` mayor o igual al banco pasa a `NULL`, que significaba lo mismo). `exam_exercises` y `exams.pick_count` quedan obsoletos pero se conservan.
- `exam_access`, `attempt_overrides` y `attempts.exercise_meta` (`{}` en los intentos anteriores).

Las cuentas de desarrollo (`NODE_ENV` distinto de `production` y `SEED_DEMO` activo) incluyen al profesor demo `profesor@excellab.local` / `profesor12345` (solo para desarrollo; en producción no se crea).

## Pantallas y flujos

Al abrir el sitio servido por el servidor, el navegador consulta `GET /api/auth/me`. Si la API responde (200 o 401) entra en **modo laboratorio**: aparece una barra superior con *Práctica libre · Exámenes · Mis resultados* (y, para el personal, un acceso a la consola de gestión), el chip del usuario con su menú (*Mi perfil*, *Cambiar contraseña*, *Cerrar sesión*) y *Cerrar sesión* (o *Ingresar*). Si la API no responde, o la página se abre con `file://`, no cambia nada: solo el simulador de práctica, sin errores.

**Estudiante**

1. **Ingresar / Crear cuenta** (nombre, correo, contraseña de mínimo 8 caracteres y confirmación). Tras ingresar vuelve a la ruta que se quería abrir.
2. **Exámenes**: tarjetas con duración, cantidad de ejercicios, intentos usados/restantes, estado (disponible, en curso → *Continuar*, cerrado, sin intentos) y mejor resultado con *Aprobado/Reprobado*.
3. **Instrucciones**: descripción, instrucciones del autor (se muestran con un renderizador mínimo y seguro: `# títulos`, `- listas`, `**negrita**`, `*cursiva*` y `` `código` ``; todo lo demás, incluido HTML, se ve como texto), reglas del examen según sus ajustes, el campo *Código de acceso* si el examen lo pide (`ACCESS_CODE_REQUIRED` / `INVALID_ACCESS_CODE` se explican en el campo) y la casilla obligatoria *He leído y acepto las instrucciones*, que habilita *Comenzar intento*. Si ya hay un intento en curso se ofrece *Continuar intento*.
4. **Examen**: barra con título, intento, progreso (*n de N ejercicios*), cronómetro y lista de ejercicios agrupada por sección (cuando hay más de una), encima del simulador cargado con el libro del ejercicio. Las instrucciones del ejercicio viven en una **pestaña discreta pegada al borde izquierdo** de la pantalla (semitransparente mientras está cerrada): al pulsarla se abre una tarjeta flotante no modal con la sección, el título, los puntos y el enunciado. Se cierra con la pestaña, con *Escape* o con el botón ×; no bloquea el simulador, y su estado abierto/cerrado se recuerda por intento (`sessionStorage`). En el teléfono es una hoja abajo a la izquierda que nunca tapa la barra de fórmulas. *Terminar ejercicio* pide confirmación, califica y **bloquea** el ejercicio; lo que se muestra depende de `feedbackMode` (nada, solo puntaje o puntaje con cada verificación). *Finalizar examen* avisa de los ejercicios sin enviar y muestra el resultado: porcentaje, nota, aprobado/reprobado y detalle por ejercicio, salvo que `resultsVisible` sea `false` (entonces se muestra «Resultados disponibles al cerrar el examen» o el aviso de nota oculta). Con `allowReview`, *Revisar mis respuestas* abre cada libro enviado en solo lectura con su resultado por verificación (`#/intento/:id?revisar=1`).
5. **Mis resultados**: por examen, cada intento con nota y fecha, y el resultado que cuenta según la política (`best`/`last`).

Comportamientos del examen: el cronómetro se calcula con la hora del **servidor** (`serverNow`/`deadlineAt`; el reloj local solo mide el tiempo transcurrido) y se reajusta con cada guardado; se avisa a los 5 min y 1 min; al llegar a 0 se finaliza solo. El borrador se guarda unos 2,5 s después de cada cambio, al cambiar de ejercicio, al ocultar la pestaña y al cerrarla. Al recargar a mitad del intento se retoma desde `GET /api/attempts/:id` (borradores, ejercicios enviados y tiempo). Los libros de examen **nunca** se guardan en el `localStorage` de la práctica libre.

**Personal (profesor y administrador)**

La consola de gestión (`#/admin…`) tiene una **barra lateral** (se contrae a íconos y se recuerda; en el teléfono pasa a un panel desplegable superior) con *Panel · Ejercicios · Exámenes · Resultados* y, solo para administradores, *Usuarios*. Un profesor ve únicamente su contenido (la API ya lo filtra) y recibe «No tienes permisos» si abre *Usuarios*; el administrador ve todo y tiene filtros y columna de propietario.

- **Panel** (`GET /api/admin/stats`): tarjetas (estudiantes, profesores —solo admin—, ejercicios, exámenes, intentos total/7 días/30 días, en curso, nota promedio, aprobación), gráfico SVG de intentos por día (14 días), exámenes más usados, intentos recientes y acciones rápidas.
- **Usuarios** (admin): tabla con búsqueda y filtros de rol y estado, paginada; crear usuario (nombre, correo, rol, contraseña temporal con *Generar* y *Copiar*, *debe cambiar la contraseña al ingresar* activado por defecto), editar nombre y rol, activar/desactivar y restablecer contraseña. `EMAIL_TAKEN`, `CANNOT_MODIFY_SELF` y `LAST_ADMIN` se explican en pantalla.
- **Primer ingreso**: si `GET /api/auth/me` trae `mustChangePassword`, o cualquier petición responde `403 PASSWORD_CHANGE_REQUIRED`, solo se muestra la pantalla *Cambia tu contraseña* (actual, nueva, confirmación e indicador de fortaleza) y, al terminar, se continúa a la ruta pedida. El chip del usuario abre un menú con *Mi perfil* (cambiar nombre), *Cambiar contraseña* y *Cerrar sesión*.
- **Banco de ejercicios**: búsqueda, filtros (dificultad, etiqueta, estado y, para admin, propietario), etiquetas y dificultad, uso (exámenes e intentos), verificaciones, selección múltiple con *Duplicar*, *Exportar JSON*, *Publicar* y *Pasar a borrador*, *Importar JSON* (archivo o pegado, con el resultado de cada ejercicio) y paginación. El editor agrega dificultad, etiquetas (hasta 10), minutos estimados y categoría a lo de siempre (instrucciones, puntos, **hoja inicial editada dentro del simulador real**, verificaciones y *Probar calificación*).
- **Constructor de exámenes**: barra superior fija con el estado, el aviso de cambios sin guardar y *Guardar* / *Publicar*, y seis pestañas: *General* (título, descripción, instrucciones con barra de formato y vista previa, estado, propietario), *Reglas y tiempo* (duración, intentos, escala, aprobación, política de nota, ventana de fechas, mezclar secciones, código de acceso con *Generar*/*Quitar*, restringir a la lista), *Resultados* (`feedbackMode`, `resultMode` y `allowReview`, cada uno con una línea que explica su efecto), *Secciones y ejercicios* (agregar, renombrar, quitar y reordenar secciones; por sección, «todos» o una cantidad validada en vivo contra los publicados, mezclar, puntos por ejercicio en este examen y el selector del banco con búsqueda y filtros; totales de ejercicios por intento, banco y puntos esperados; **Simular sorteo** / *Sortear otra vez*; se guarda con `PUT /admin/exams/:id/blocks`), *Acceso e intentos extra* (lista de correos con encontrados y desconocidos; conceder y revocar intentos extra) y *Publicación* (lista de requisitos que replica la validación del servidor, publicar/despublicar, duplicar y eliminar con el aviso 409 `EXAM_IN_USE`). Salir con cambios sin guardar pide confirmación.
- **Lista de exámenes**: tarjetas con estado, propietario, secciones, ejercicios, intentos, tipo de acceso (público, restringido o con código) y acciones (editar, resultados, analíticas, publicar, duplicar, eliminar).
- **Analíticas** (`GET /admin/exams/:id/analytics`): intentos, estudiantes, promedio, aprobación y tiempo medio; histograma SVG de 10 rangos; tabla por ejercicio con barras que marcan los más difíciles; tabla por estudiante y *Exportar CSV*.
- **Resultados**: filtros por examen y estudiante, resumen por estudiante, tabla de intentos con insignias de aprobado/reprobado, *Exportar CSV* y enlace a analíticas; el detalle de un intento muestra puntajes, sección de cada ejercicio, el resultado de cada verificación y el libro enviado, en solo lectura dentro del simulador.

### Rutas (hash)

| Ruta | Pantalla |
| --- | --- |
| `#/practica` | Práctica libre (por defecto). |
| `#/login`, `#/registro` | Ingreso y registro (`?next=` indica a dónde volver). |
| `#/examenes`, `#/examenes/:id` | Lista de exámenes e instrucciones de un examen. |
| `#/intento/:id` | Examen en curso; si el intento terminó, su resultado (`?revisar=1`: revisión de respuestas). |
| `#/resultados` | Mis resultados. |
| `#/admin` | Panel de gestión (personal). |
| `#/admin/ejercicios`, `…/nuevo`, `…/:id`, `…/:id/hoja` | Ejercicios: banco, nuevo, editar, hoja inicial. |
| `#/admin/examenes`, `…/nuevo`, `…/:id`, `…/:id/analiticas` | Exámenes: lista, nuevo, constructor, analíticas. |
| `#/admin/usuarios` | Usuarios (solo administrador). |
| `#/admin/resultados`, `#/admin/intentos/:id` | Resultados y detalle de un intento. |

### Enlace desde otra plataforma (plataforma de talleres)

Para mandar a un estudiante directo a un examen, enlaza a la raíz del sitio con el id del examen (se ve en el editor del examen, *Enlace directo para estudiantes*):

```
https://TU-DOMINIO/?exam=<id-del-examen>
```

Si no tiene sesión, pasa por *Ingresar* (o *Crear cuenta*) y después se abre la pantalla de instrucciones de ese examen (`#/examenes/<id>`). El parámetro se limpia de la URL al cargar. Para otras rutas internas existe `?next=%23%2Fresultados` (solo rutas de la propia aplicación; cualquier otra cosa se ignora). Es el mismo origen que la API, así que no hace falta CORS ni tokens; la sesión es la cookie `gl_session`.

## Pruebas

`npm test` ejecuta, además de las pruebas del motor y de la API:

- `server/test/labcore.test.ts`: lógica pura de `src/lab-core.js` (rutas y enlaces profundos, reloj/cuenta regresiva, autoguardado con temporizadores falsos, conversión verificaciones ⇄ API, validación de formularios, renderizador Markdown-lite con intentos de XSS, constructor de bloques ⇄ `PUT /blocks`, lista de requisitos de publicación, contraseñas, etiquetas y gráficos).
- `server/test/lab-flow.test.ts`: la página compilada (`public/index.html`) dentro de **jsdom** contra un servidor real (PGlite en memoria). Cubre registro, inicio de sesión, flujo completo del estudiante (incluida la pestaña de instrucciones: abrir, cerrar, `Escape`, clase y `aria-*`), flujo del administrador, barra lateral según el rol, usuarios, cambio de contraseña obligatorio, constructor de exámenes (secciones, validación, guardado), lista de acceso e intentos extra, código de acceso, notas ocultas, modo solo práctica sin API y desde `file://`. jsdom no calcula diseño ni se ve en pantalla: lo visual y el uso táctil se deben revisar a mano en un navegador.

## Estructura

| Ruta | Contenido |
| --- | --- |
| `src/` | Código del sitio: `engine.js` (motor sin DOM), `app.js` (simulador), `lab-core.js` (lógica pura del laboratorio), `lab.js` (barra, rutas, acceso, exámenes, examen en curso, perfil y cambio de contraseña), `lab-staff.js` (consola del personal: barra lateral, panel, usuarios, banco, lista de exámenes, analíticas y resultados), `lab-admin.js` (editor de ejercicios, hoja inicial y detalle de intento), `lab-exam.js` (constructor de exámenes), `style.css`, `lab.css`, `body.html`, `template.html`. |
| `scripts/build.mjs` | Genera `index.html`, `public/index.html` y `gridlab.html`. |
| `server/src/` | API en TypeScript: `auth/`, `attempts/` (alumno), `exercises/` y `exams/` (personal; `exams/service.ts` tiene los bloques), `users/` (administración de usuarios), `stats/` (estadísticas, análisis y CSV), `grid/` (motor + verificaciones), `db/`, `seed/`. |
| `server/migrations/` | Migraciones SQL numeradas. |
| `server/test/` | Pruebas con `node:test`. |
| `GUIA-DESARROLLO.md` | Cómo está construido el simulador y cómo habilitar botones simulados. |

Los archivos `index.html` y `gridlab.html` de la raíz son **generados**: no los edites, cambia `src/` y ejecuta `npm run build:site`.
