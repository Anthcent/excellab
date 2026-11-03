import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { GridEngine, type Engine, type Workbook } from "../src/grid/engine.js";

type Sheets = Record<string, Record<string, string>>;

function book(sheets: Sheets): Workbook {
  return {
    name: "Libro1",
    sheets: Object.entries(sheets).map(([name, cells]) => ({
      name,
      cells: Object.fromEntries(Object.entries(cells).map(([addr, v]) => [addr, { v }])),
      colW: {},
    })),
  };
}

function engineFor(sheets: Sheets = { Hoja1: {} }, decimal = ".") {
  return GridEngine.createEngine({ workbook: book(sheets), decimal });
}

/** Evaluates a formula on sheet 0 and returns a plain JS value, or the Spanish error text. */
function ev(formula: string, sheets: Sheets = { Hoja1: {} }): unknown {
  const eng = engineFor(sheets);
  const v = eng.evalFormulaText(formula, 0);
  return eng.isErr(v) ? eng.errText((v as { e: string }).e) : v;
}

const DATA: Sheets = {
  Hoja1: { A1: "10", A2: "20", A3: "30", A4: "texto", B1: "a", B2: "b", B3: "c", C1: "1", C2: "2", C3: "3" },
};

describe("engine: syntax and precedence", () => {
  test("unary minus binds tighter than ^ (-2^2 = 4)", () => assert.equal(ev("=-2^2"), 4));
  test("^ is left associative (2^3^2 = 64)", () => assert.equal(ev("=2^3^2"), 64));
  test("multiplication before addition, parentheses override", () => {
    assert.equal(ev("=2+3*4"), 14);
    assert.equal(ev("=(2+3)*4"), 20);
  });
  test("percent postfix", () => {
    assert.equal(ev("=50%"), 0.5);
    assert.equal(ev("=200*10%"), 20);
  });
  test("string concatenation and comparison", () => {
    assert.equal(ev('="a"&"b"&1'), "ab1");
    assert.equal(ev("=3>2"), true);
    assert.equal(ev('="A"="a"'), true);
  });
});

describe("engine: references", () => {
  test("ranges and absolute references", () => {
    const eng = engineFor({ Hoja1: { A1: "1", A2: "2", A3: "3", B1: "=SUMA($A$1:$A$3)", B2: "=$A$1+A2" } });
    assert.equal(eng.cellValue(0, 0, 1), 6);
    assert.equal(eng.cellValue(0, 1, 1), 3);
  });
  test("shiftFormula respects $ anchors", () => {
    const eng = engineFor();
    assert.equal(eng.shiftFormula("=$A$1+B2", 1, 1), "=$A$1+C3");
    assert.equal(eng.shiftFormula("=A$1+$B2", 2, 2), "=C$1+$B4");
  });
  test("cross-sheet references, quoted names included", () => {
    const sheets: Sheets = { Hoja1: { A1: "=Datos!A1*2", A2: "='Mi hoja'!A1+1" }, Datos: { A1: "21" }, "Mi hoja": { A1: "9" } };
    const eng = engineFor(sheets);
    assert.equal(eng.cellValue(0, 0, 0), 42);
    assert.equal(eng.cellValue(0, 1, 0), 10);
  });
  test("whole-column ranges", () => assert.equal(ev("=SUMA(A:A)", DATA), 60));
});

describe("engine: errors", () => {
  test("division by zero", () => assert.equal(ev("=1/0"), "#¡DIV/0!"));
  test("text in arithmetic", () => assert.equal(ev('="a"+1'), "#¡VALOR!"));
  test("unknown function", () => assert.equal(ev("=NOEXISTE(1)"), "#¿NOMBRE?"));
  test("unknown sheet gives #REF!", () => assert.equal(ev("=Nada!A1"), "#¡REF!"));
  test("references beyond the last column or row give #REF!", () => {
    assert.equal(ev("=ZZ1"), "#¡REF!");
    assert.equal(ev("=AA1"), "#¡REF!");
    assert.equal(ev("=A100000"), "#¡REF!");
    assert.equal(ev("=SUMA(A1:AB3)"), "#¡REF!");
    assert.equal(ev("=Z1"), null); // the last column (Z) is still valid
  });
  test("errors propagate through functions and IFERROR catches them", () => {
    assert.equal(ev("=SUMA(1,1/0)"), "#¡DIV/0!");
    assert.equal(ev('=SI.ERROR(1/0,"x")'), "x");
  });
  test("circular references are detected and do not hang", () => {
    const eng = engineFor({ Hoja1: { A1: "=B1+1", B1: "=A1+1" } });
    eng.cellValue(0, 0, 0);
    assert.ok(eng.circular.size > 0);
  });
});

describe("engine: function library", () => {
  const cases: [string, unknown][] = [
    ["=SUMA(A1:A3)", 60],
    ["=PROMEDIO(A1:A3)", 20],
    ["=MAX(A1:A3)", 30],
    ["=MIN(A1:A3)", 10],
    ["=CONTAR(A1:A4)", 3],
    ["=CONTARA(A1:A4)", 4],
    ['=CONTAR.SI(B1:B3,"b")', 1],
    ['=CONTAR.SI(A1:A3,">15")', 2],
    ['=SUMAR.SI(A1:A3,">=20")', 50],
    ['=SUMAR.SI(B1:B3,"c",C1:C3)', 3],
    ['=SI(A1>5,"mayor","menor")', "mayor"],
    ["=SI(A1>50,1,0)", 0],
    ["=Y(A1>5,A2>5)", true],
    ["=O(A1>50,A2>5)", true],
    ["=NO(A1>5)", false],
    ["=BUSCARV(\"b\",B1:C3,2,FALSO)", 2],
    ["=BUSCARV(25,A1:C3,1,VERDADERO)", 20],
    ["=BUSCARV(\"z\",B1:C3,2,FALSO)", "#N/D"],
    ["=COINCIDIR(\"c\",B1:B3,0)", 3],
    ["=INDICE(A1:A3,2)", 20],
    ["=REDONDEAR(2.567,2)", 2.57],
    ["=ENTERO(7.9)", 7],
    ["=ABS(-5)", 5],
    ["=RESIDUO(10,3)", 1],
    ["=POTENCIA(2,10)", 1024],
    ["=RAIZ(81)", 9],
    ['=CONCATENAR("a","b","c")', "abc"],
    ['=IZQUIERDA("excel",2)', "ex"],
    ['=DERECHA("excel",3)', "cel"],
    ['=EXTRAE("excel",2,3)', "xce"],
    ['=LARGO("hola")', 4],
    ['=MAYUSC("primero")', "PRIMERO"],
    ['=MINUSC("ABC")', "abc"],
    ['=ESPACIOS("  a   b ")', "a b"],
    ["=MEDIANA(A1:A3)", 20],
    ["=SUMAPRODUCTO(C1:C3,C1:C3)", 14],
    ['=TEXTO(1234.5,"#,##0.00")', "1,234.50"],
    ["=ESNUMERO(A1)", true],
    ["=ESTEXTO(A4)", true],
  ];
  for (const [formula, expected] of cases) {
    test(formula, () => assert.deepEqual(ev(formula, DATA), expected));
  }

  test("FECHA / AÑO / MES / DIA round trip", () => {
    const serial = (Date.UTC(2024, 2, 15) - Date.UTC(1899, 11, 30)) / 86_400_000;
    assert.equal(ev("=FECHA(2024,3,15)"), serial);
    assert.equal(ev("=AÑO(FECHA(2024,3,15))"), 2024);
    assert.equal(ev("=MES(FECHA(2024,3,15))"), 3);
    assert.equal(ev("=DIA(FECHA(2024,3,15))"), 15);
  });

  test("English function names are accepted too", () => assert.equal(ev("=SUM(1,2,3)"), 6));
  test("decimal setting does not change stored (canonical) formulas", () => {
    const eng = engineFor({ Hoja1: { A1: "=1.5*2", A2: "=SI(A1>2.5,1,0)" } }, ",");
    assert.equal(eng.cellValue(0, 0, 0), 3);
    assert.equal(eng.cellValue(0, 1, 0), 1);
  });
});

describe("engine: work budget", () => {
  test("a workbook that exceeds the budget aborts instead of hanging", () => {
    const eng: Engine = engineFor({ Hoja1: { A1: "=SUMA(B1:Z200)", A2: "=SUMA(B1:Z200)+A1" } });
    eng.S.budget = 5;
    assert.throws(
      () => eng.cellValue(0, 1, 0),
      (error: unknown) => (error as { budget?: boolean }).budget === true,
    );
  });
  test("a normal workbook fits easily in the default server budget", () => {
    const eng = engineFor({ Hoja1: { A1: "=SUMA(B1:Z200)" } });
    eng.S.budget = 400_000;
    assert.equal(eng.cellValue(0, 0, 0), 0);
  });
});

describe("sanitizeWorkbook", () => {
  const { sanitizeWorkbook } = GridEngine;
  test("rejects non workbooks", () => {
    for (const bad of [null, 5, "x", {}, { sheets: [] }, { sheets: "no" }, { sheets: [null] }]) {
      assert.throws(() => sanitizeWorkbook(bad));
    }
  });
  test("coerces values, drops out of range cells and unknown properties", () => {
    const wb = sanitizeWorkbook({
      name: 7,
      sheets: [{ name: 5, cells: { A1: { v: 12 }, B1: { v: null }, ZZ9: { v: "x" }, A9999: { v: "x" }, C1: { v: "ok", s: { b: 1, evil: "<script>", fill: "#fff" } } }, colW: { 0: "a", 1: 80 }, extra: 1 }],
    });
    assert.equal(wb.name, "Libro1");
    assert.equal(wb.sheets[0]!.name, "Hoja1");
    assert.deepEqual(Object.keys(wb.sheets[0]!.cells).sort(), ["A1", "C1"]);
    assert.equal(wb.sheets[0]!.cells.A1!.v, "12");
    assert.deepEqual(wb.sheets[0]!.cells.C1!.s, { b: true, fill: "#fff" });
    assert.deepEqual(wb.sheets[0]!.colW, { 1: 80 });
    assert.equal("extra" in wb.sheets[0]!, false);
  });
  test("enforces limits and unique sheet names", () => {
    assert.throws(() => sanitizeWorkbook({ sheets: Array.from({ length: 3 }, () => ({ cells: {} })) }, { maxSheets: 2 }));
    assert.throws(() => sanitizeWorkbook({ sheets: [{ cells: { A1: { v: "x".repeat(50) } } }] }, { maxStr: 10 }));
    assert.throws(() => sanitizeWorkbook({ sheets: [{ cells: { A1: { v: "1" }, A2: { v: "1" } } }] }, { maxCells: 1 }));
    const wb = sanitizeWorkbook({ sheets: [{ name: "X", cells: {} }, { name: "x", cells: {} }] });
    assert.notEqual(wb.sheets[0]!.name.toLowerCase(), wb.sheets[1]!.name.toLowerCase());
  });
});
