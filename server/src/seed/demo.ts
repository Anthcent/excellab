import type { Db } from "../db/db.js";
import type { Workbook } from "../grid/engine.js";
import type { Check } from "../grid/checks.js";

/** Demo content so the owner can try the whole flow right after the first boot. Runs once (marker in app_meta). */

const HEADER = { b: true, fill: "#196B24", color: "#FFFFFF" };
const INPUT = { fill: "#FFF2CC" };

type Cells = Workbook["sheets"][number]["cells"];
function sheet(name: string, cells: Cells, colW: Record<string, number>): Workbook["sheets"][number] {
  return { name, cells, colW, sel: { ar: 0, ac: 0, fr: 0, fc: 0 } };
}
const put = (cells: Cells, addr: string, v: string | number, s?: Record<string, unknown>) => {
  cells[addr] = { v: String(v), ...(s && { s }) };
};

interface DemoExercise {
  title: string;
  instructions: string;
  workbook: Workbook;
  checks: Check[];
}

function demoExercises(): DemoExercise[] {
  // 1. SUMA
  const ventas: Cells = {};
  put(ventas, "A1", "Mes", HEADER);
  put(ventas, "B1", "Importe", HEADER);
  [["Enero", 120], ["Febrero", 85], ["Marzo", 240], ["Abril", 60], ["Mayo", 95]].forEach(([m, n], i) => {
    put(ventas, `A${i + 2}`, m!);
    put(ventas, `B${i + 2}`, n!);
  });
  put(ventas, "A8", "Total", { b: true });
  put(ventas, "B8", "", INPUT);

  // 2. SI
  const notas: Cells = {};
  ["Alumno", "Nota", "Resultado"].forEach((h, i) => put(notas, `${"ABC"[i]}1`, h, HEADER));
  [["Ana", 14], ["Luis", 8], ["Marta", 10], ["Pedro", 6]].forEach(([n, g], i) => {
    put(notas, `A${i + 2}`, n!);
    put(notas, `B${i + 2}`, g!);
    put(notas, `C${i + 2}`, "", INPUT);
  });

  // 3. BUSCARV
  const productos: Cells = {};
  ["Código", "Producto", "Precio"].forEach((h, i) => put(productos, `${"ABC"[i]}1`, h, HEADER));
  [["P001", "Cuaderno", 2.5], ["P002", "Lápiz", 0.8], ["P003", "Mochila", 18], ["P004", "Regla", 1.2]].forEach(([c, p, pr], i) => {
    put(productos, `A${i + 2}`, c!);
    put(productos, `B${i + 2}`, p!);
    put(productos, `C${i + 2}`, pr!);
  });
  put(productos, "E1", "Código", { b: true });
  put(productos, "F1", "P003", INPUT);
  put(productos, "E2", "Precio", { b: true });
  put(productos, "F2", "", INPUT);

  // 4. CONTAR.SI
  const clientes: Cells = {};
  put(clientes, "A1", "Cliente", HEADER);
  put(clientes, "B1", "Ciudad", HEADER);
  [["Rosa", "Caracas"], ["Juan", "Valencia"], ["Elena", "Caracas"], ["Carlos", "Maracay"], ["Sofía", "Caracas"], ["Diego", "Valencia"], ["Lucía", "Mérida"], ["Pablo", "Caracas"]].forEach(
    ([c, city], i) => {
      put(clientes, `A${i + 2}`, c!);
      put(clientes, `B${i + 2}`, city!);
    },
  );
  put(clientes, "D1", "Ciudad", { b: true });
  put(clientes, "E1", "Caracas", INPUT);
  put(clientes, "D2", "Clientes", { b: true });
  put(clientes, "E2", "", INPUT);

  return [
    {
      title: "Suma de ventas (SUMA)",
      instructions: "En la celda B8 calcula el total de los importes de B2:B6 usando la función SUMA.",
      workbook: { name: "Libro1", sheets: [sheet("Ventas", ventas, { "0": 90, "1": 90 })] },
      checks: [
        { type: "cell_value", cell: "B8", expected: 600, requireFormula: true, points: 7, label: "El total es correcto" },
        { type: "cell_formula_uses", cell: "B8", functions: ["SUMA"], points: 3, label: "Usa la función SUMA" },
      ],
    },
    {
      title: "Aprobado o reprobado (SI)",
      instructions: 'En C2:C5 escribe una fórmula con SI que muestre "Aprobado" si la nota es 10 o más, y "Reprobado" en caso contrario.',
      workbook: { name: "Libro1", sheets: [sheet("Notas", notas, { "0": 90, "1": 70, "2": 100 })] },
      checks: [
        {
          type: "range_values",
          range: "C2:C5",
          expected: [["Aprobado"], ["Reprobado"], ["Aprobado"], ["Reprobado"]],
          points: 7,
          label: "Los resultados son correctos",
        },
        { type: "cell_formula_uses", cell: "C2", functions: ["SI"], points: 3, label: "Usa la función SI" },
      ],
    },
    {
      title: "Buscar un precio (BUSCARV)",
      instructions: "En F2 busca el precio del código que está en F1 usando BUSCARV sobre la tabla A2:C5. Pide coincidencia exacta.",
      workbook: { name: "Libro1", sheets: [sheet("Productos", productos, { "0": 70, "1": 90, "2": 70, "4": 70 })] },
      checks: [
        { type: "cell_value", cell: "F2", expected: 18, requireFormula: true, points: 7, label: "El precio es correcto" },
        { type: "cell_formula_uses", cell: "F2", functions: ["BUSCARV"], points: 3, label: "Usa la función BUSCARV" },
      ],
    },
    {
      title: "Contar clientes por ciudad (CONTAR.SI)",
      instructions: "En E2 cuenta cuántos clientes hay en la ciudad escrita en E1, con la función CONTAR.SI sobre B2:B9.",
      workbook: { name: "Libro1", sheets: [sheet("Clientes", clientes, { "0": 80, "1": 90, "3": 80 })] },
      checks: [
        { type: "cell_value", cell: "E2", expected: 4, requireFormula: true, points: 7, label: "La cantidad es correcta" },
        { type: "cell_formula_uses", cell: "E2", functions: ["CONTAR.SI"], points: 3, label: "Usa la función CONTAR.SI" },
      ],
    },
  ];
}

export async function seedDemo(db: Db, log: (message: string) => void) {
  const marker = await db.query("SELECT 1 FROM app_meta WHERE key = 'demo_seeded'");
  if (marker.rows.length) return;
  await db.tx(async (t) => {
    const ids: string[] = [];
    for (const ex of demoExercises()) {
      const { rows } = await t.query<{ id: string }>(
        `INSERT INTO exercises (title, instructions, points, workbook, checks, status)
         VALUES ($1, $2, 10, $3::jsonb, $4::jsonb, 'published') RETURNING id`,
        [ex.title, ex.instructions, JSON.stringify(ex.workbook), JSON.stringify(ex.checks)],
      );
      ids.push(rows[0]!.id);
    }
    const { rows } = await t.query<{ id: string }>(
      `INSERT INTO exams (title, instructions, duration_minutes, max_attempts, pick_count, scale, pass_percent, grade_policy, status)
       VALUES ($1, $2, 30, 2, NULL, 20, 60, 'best', 'published') RETURNING id`,
      [
        "Examen demo de fórmulas",
        "Este examen tiene 4 ejercicios de fórmulas básicas, en orden aleatorio.\n\n- Dispones de 30 minutos desde que comienzas.\n- Tienes 2 intentos; cuenta la mejor nota.\n- Cada ejercicio se envía una sola vez y se califica al instante.\n- Cuando se acaba el tiempo, el examen se cierra y se califica lo que hayas guardado.",
      ],
    );
    for (const [position, id] of ids.entries()) {
      await t.query("INSERT INTO exam_exercises (exam_id, exercise_id, position) VALUES ($1, $2, $3)", [rows[0]!.id, id, position]);
    }
    await t.query("INSERT INTO app_meta (key, value) VALUES ('demo_seeded', '1')");
  });
  log("Seeded demo exam with 4 exercises");
}
