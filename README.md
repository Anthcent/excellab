# ExcelLab (GridLab)

Simulador de hoja de cálculo con apariencia de Excel en español, pensado para enseñar y practicar fórmulas, incluso desde el teléfono en horizontal.

## Uso

Abre `index.html` en el navegador. No necesita instalación ni servidor.

Para probarlo en un teléfono de la misma red Wi-Fi, sírvelo desde la PC:

```bash
python -m http.server 8080 --bind 0.0.0.0
```

y abre `http://IP-DE-LA-PC:8080/index.html` en el teléfono.

## Qué incluye

- Cinta de opciones completa (Inicio, Insertar, Dibujar, Disposición de página, Fórmulas, Datos, Revisar, Vista, Ayuda) con dos temas: **Excel**, con íconos a color, y **Blanco**.
- Motor de fórmulas propio con más de 90 funciones con nombres de Excel en español (SUMA, SI, BUSCARV, CONTAR.SI…). Acepta separador `;` o `,` según la configuración regional.
- Autocompletado, ayuda de argumentos, referencias de colores, F4 para referencias absolutas, controlador de relleno, ordenar, filtro, formatos y deshacer/rehacer.
- Modo teléfono: cinta flotante, barra de acciones rápidas, teclado propio (123, ABC y fx) y zoom con dos dedos.
- Hoja de práctica que se autocorrige.

## Archivos

| Archivo | Descripción |
| --- | --- |
| `index.html` | Versión lista para abrir o publicar (por ejemplo, con GitHub Pages). |
| `gridlab.html` | Código fuente que se edita. `index.html` se genera a partir de este archivo. |
| `GUIA-DESARROLLO.md` | Cómo está construido y cómo habilitar los botones que todavía son simulados. |

Los datos de cada usuario se guardan solo en su navegador (`localStorage`).
