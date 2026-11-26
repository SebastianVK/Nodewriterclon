# Plan de migración a Tauri 2 + Rust

> Estado: propuesta. No se ha modificado código de la app.
> Objetivo principal: **que StoryGraph abra en ~0,5–1 s** en lugar de los 4–13 s actuales.
> Objetivos secundarios: **dos proyectos a la vez** (multi-ventana / panel de referencia) y
> **copiar tarjetas entre proyectos**.

---

## 1. Diagnóstico

Hoy el arranque no lo domina la app, sino la cadena de lanzamiento:

| Paso | Qué ocurre | Costo estimado |
| --- | --- | --- |
| 1 | `Iniciar StoryGraph.vbs` → `cmd` → `npm run dev` | 0,8–1,5 s |
| 2 | Vite frío: config, plugin React, escaneo/optimización de deps | 1,5–4 s (5–10 s la primera vez) |
| 3 | El VBS sondea `localhost:5175` cada 500 ms | 0–0,5 s |
| 4 | `shell.Run URL` → arranque en frío del navegador | 1,5–6 s |
| 5 | Descarga/parseo de 705 KB de JS, montaje de React, rehidratación de **todos** los proyectos desde localStorage | 0,3–1,5 s |

**Total actual: 4–13 s**, y el paso 5 empeora a medida que crece la bóveda porque
`persist` (clave `storygraph-v2`) deserializa *todos* los proyectos al iniciar.

Datos medidos del repo:

- `dist/assets/index-*.js`: **705 KB** en un único chunk (sin code splitting).
- `dist/assets/index-*.css`: 57 KB.
- `src/`: ~8.200 líneas TS/TSX + ~2.500 de CSS; `App.tsx` solo: **2.834 líneas**.
- Persistencia: Zustand `persist` → localStorage; imágenes en Dexie/IndexedDB (`storygraph-images`).
- Exportaciones: JSZip en el navegador (backup `.zip` y EPUB).
- **Sin tests** (no hay Vitest ni Playwright).
- Sin backend.

Conclusión: el costo está en **npm + Vite + un navegador completo**, no en React ni en la lógica.

---

## 2. Decisión de arquitectura

| Decisión | Elección | Motivo |
| --- | --- | --- |
| Shell | **Tauri 2** | Usa WebView2 del sistema (sin Chromium embebido), instalador de 5–10 MB, arranque ~0,5 s |
| UI | **Se conserva React + TS + Vite + React Flow + Zustand** | Reescribir la UI en Rust costaría meses y perdería el UI 2.0 |
| Núcleo de negocio | **Se queda en TypeScript** (Rust delgado) | Menor costo de mantenimiento; Rust no aporta al arranque |
| Persistencia | **Un `project.json` + `images/` por proyecto** | Portable, legible, multi-ventana seguro, sync por OneDrive, sin migraciones de esquema |
| Lógica en Rust | Solo ventanas, archivos, diálogos, autosave, imágenes en disco | Mantener el proyecto editable como hoy |

### Lo que NO se hace

- ❌ Reescribir la UI en Leptos/Dioxus/Yew/egui/iced.
- ❌ Mover grafos/backup/EPUB a WASM (sin beneficio perceptible).
- ❌ Electron (mismo resultado, +150 MB y arranque más lento).
- ❌ SQLite en la primera iteración (se evalúa solo si hace falta búsqueda full-text).

---

## 3. Requisitos

### 3.1 Estado actual de la máquina de desarrollo

| Requisito | Estado | Nota |
| --- | --- | --- |
| Rust 1.98 estable (`x86_64-pc-windows-msvc`) | ✅ instalado | `D:\Usuarios\Hp\.rustup` + `.cargo` (1,94 GB) |
| WebView2 Runtime v157 | ✅ instalado | Viene con Windows 10/11 |
| Node 22.23 + npm 10.9 | ✅ instalado | Necesario para compilar el frontend |
| **MSVC Build Tools / Windows SDK (`link.exe`)** | ❌ **falta** | **Bloqueante**: sin esto `cargo build` no enlaza |
| Espacio libre C: / D: | ✅ 34,4 / 39,2 GB | Suficiente |

### 3.2 Software a instalar

1. **Visual Studio Build Tools 2022** con la carga **"Desarrollo para escritorio con C++"**
   (MSVC v143 + Windows 11 SDK). Instalación personalizada mínima: 2–4 GB.
   ```powershell
   winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
     --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```
2. **Tauri CLI** (como devDependency, no global):
   ```powershell
   npm install -D @tauri-apps/cli
   ```
3. Plugins de Tauri 2:
   `dialog`, `fs`, `clipboard-manager`, `window-state`, `single-instance`, `opener`, `log`.
4. (Opcional) `gh` CLI para crear PRs desde consola.

### 3.3 Disco

| Componente | Tamaño | Ubicación |
| --- | --- | --- |
| MSVC Build Tools 2022 | 2–4 GB | C: |
| Caché de crates (`~600` deps de Tauri) | 400–800 MB | `CARGO_HOME` (D:) |
| `src-tauri/target/` debug | 2–4 GB | D: (junto al proyecto) |
| `src-tauri/target/` release | 0,5–1,5 GB | D: |
| Instalador final | 5–10 MB | — |
| App instalada | 20–40 MB | C: |
| **Total adicional** | **~5–13 GB** | — |

Recomendaciones:

- Excluir de Windows Defender `target\`, `.cargo\` y `.rustup\` (builds 20–50% más rápidos).
- `cargo clean` cuando `target/` se descontrole.
- SSD obligatorio en la práctica: Rust castiga los HDD.

### 3.4 Hardware

| | Mínimo | Cómodo |
| --- | --- | --- |
| RAM | 8 GB | 16 GB |
| CPU | 4 núcleos | 6–8 núcleos |
| Disco | SSD | SSD NVMe |
| GPU | integrada | integrada |

Tiempos esperables (4 núcleos): primer `tauri build` 8–15 min; incremental de Rust 5–30 s;
frontend < 1 s; `vite build` ~5 s.

---

## 4. Fases

Cada fase deja la app funcionando y es reversible. No hay big bang.

### Fase 0 — Medir (2–3 h)

- Instrumentar marcas de tiempo: `t0` doble clic, `t1` servidor arriba, `t2` navegador abierto,
  `t3` primer pintado, `t4` store rehidratado.
- Añadir `performance.mark()` en `main.tsx` alrededor del montaje y de la rehidratación.
- Confirmar el reparto real del tiempo antes de invertir en la migración.

**Criterio de salida:** tabla de tiempos reales con el porcentaje de cada etapa.

### Fase 1 — Shell Tauri con la persistencia actual (1–2 días) ⭐

- `npx tauri init` sobre el repo; `beforeDevCommand: "npm run dev"`,
  `beforeBuildCommand: "npm run build"`, `frontendDist: "../dist"`.
- Ventana con el fondo del tema oscuro para evitar el flash blanco.
- **Se mantiene localStorage + Dexie tal cual.** Cero migración, cero riesgo.
- Reemplazar el acceso directo del VBS por el `.exe`.
- Verificar: React Flow, drag, CSS glass, filtros SVG, fuentes locales, `crypto.randomUUID`,
  IndexedDB y `window.open` (impresión) dentro de WebView2.

**Criterio de salida:** doble clic → ventana visible en **< 1,5 s**; app funcional al 100%.

> Esta fase sola ya cumple el objetivo principal. Las siguientes son mejoras.

### Fase 2 — Persistencia en disco (3–5 días)

- Estructura por proyecto (ver §5).
- Comandos Rust: `list_projects`, `load_project`, `save_project`, `delete_project`,
  `put_image`, `get_image`, `export_project_zip`, `import_project_zip`.
- Autosave con debounce (~800 ms) + guardado al cerrar + `.bak` de la versión anterior.
- Escritura atómica: `project.json.tmp` → `fsync` → `rename`.
- Adaptador de persistencia en el frontend: si corre en Tauri usa los comandos; si corre en
  navegador (`npm run dev`) cae a localStorage. Así el modo web no se rompe.
- Migración one-shot: leer `localStorage['storygraph-v2']` y Dexie `storygraph-images`,
  escribir las carpetas, verificar contadores, y **no borrar** el almacenamiento web.
- Imágenes servidas por protocolo propio (`sg://img/<id>` o `convertFileSrc`), no base64.
- Generar tipos TS desde Rust con `ts-rs` (o `specta`).

**Criterio de salida:** abrir proyecto de 500 tarjetas en < 200 ms; ningún dato perdido tras
la migración; el backup v1 sigue exportándose e importándose igual.

### Fase 3 — Dos proyectos a la vez (2–4 días)

- Multi-ventana: una instancia del proceso, N ventanas (`WebviewWindowBuilder`), etiqueta
  `project-<id>`; el frontend lee `getCurrentWindow().label`.
- Menú contextual del proyecto: "Abrir", "Abrir en nueva ventana", "Abrir como referencia".
- Guardia contra dos ventanas sobre el **mismo** proyecto (enfocar la existente o abrir
  en solo lectura).
- Eventos Tauri para refrescar otras ventanas tras un guardado.
- Recordar tamaño/posición por proyecto (`window-state`).
- Panel de referencia (opcional, complementario): drawer lateral de solo lectura con otro
  proyecto, con búsqueda y botón "copiar a este proyecto".

**Criterio de salida:** dos proyectos editables en paralelo, sin corrupción de archivos.

### Fase 4 — Copiar tarjetas entre proyectos (2–3 días)

- `CardBundle` v1 (ver §6) + remapeo de IDs.
- Tres transportes:
  1. Portapapeles del sistema (`clipboard-manager`): "Copiar tarjetas" / "Pegar tarjetas".
  2. Archivo `.storygraph-cards.json`: "Exportar selección…" / "Importar tarjetas…".
  3. "Enviar a proyecto…": escribe directo en el `project.json` destino y notifica a su ventana.
- Copiar imágenes referenciadas (`img://id`) a la carpeta del proyecto destino.
- Codex: deduplicar por nombre normalizado, con opción "reutilizar / crear nuevo".

**Criterio de salida:** copiar 20 tarjetas con grupos, conexiones e imágenes entre dos
proyectos sin romper referencias.

### Fase 5 — Pulido de carga (2–3 días)

- Carga diferida (`React.lazy`) de `GraphView` (canvas + simulación de fuerzas), `epub.ts` /
  `backup.ts` (JSZip) y modales.
- Cargar **solo el proyecto activo** (nunca todos).
- `preload` de las 2–3 fuentes del primer pintado.
- `onlyRenderVisibleElements` y `nodeTypes` memorizados en React Flow.
- Revisar `App.tsx` (2.834 líneas) y extraer componentes/hooks **como trabajo separado**.

**Criterio de salida:** primer pintado < 1,5 s; bundle inicial reducido ≥ 30%.

---

## 5. Modelo de datos en disco

```
%APPDATA%/StoryGraph/
  projects/
    <project-id>/
      project.json          # formato storygraph-backup v1 (mismo contrato)
      project.json.bak      # versión anterior
      images/
        <image-id>.webp
  windows.json              # tamaños/posiciones por proyecto
```

`project.json` reutiliza el formato que ya produce `exportBackup()`:

```json
{
  "format": "storygraph-backup",
  "version": 1,
  "exportedAt": "2026-11-26T12:00:00.000Z",
  "app": "storygraph",
  "project": {
    "id": "uuid",
    "name": "Mi novela",
    "icon": null,
    "cards": [],
    "connections": [],
    "groups": [],
    "codex": [],
    "revisions": [],
    "createdAt": "…",
    "updatedAt": "…"
  }
}
```

Ventajas:

- El **backup es el formato de almacenamiento**: no hay dos serializadores.
- Compatibilidad con el importador de NodeWriter intacta.
- Editable a mano y sincronizable por OneDrive/Dropbox.
- Añadir campos es seguro con `#[serde(default)]` en Rust y `??` en TS.

Reglas de escritura:

- Nunca escribir directo sobre `project.json`.
- `tmp` → `fsync` → `rename` → rotar `.bak`.
- Un lock por proyecto (`Mutex<HashSet<ProjectId>>`) para impedir dos escritores.

---

## 6. Formato `CardBundle` (intercambio entre proyectos)

```json
{
  "format": "storygraph-cards",
  "version": 1,
  "exportedAt": "2026-11-26T12:00:00.000Z",
  "source": { "projectId": "uuid", "projectName": "Proyecto A" },
  "cards": [],
  "connections": [],
  "groups": [],
  "codex": [],
  "images": [{ "id": "…", "mime": "image/webp", "ext": "webp", "name": "…", "w": 1600, "h": 900 }]
}
```

Reglas de importación:

1. Remapear IDs de tarjetas, grupos, codex y conexiones (generalizar `remapProject`).
2. Incluir solo conexiones con **ambos extremos** dentro de la selección.
3. Incluir grupos que contengan tarjetas seleccionadas y conservar posiciones relativas.
4. Pegar con offset `(+40, +40)` o en la posición del cursor.
5. Copiar las imágenes referenciadas a `images/` del destino.
6. Codex: reutilizar por nombre normalizado o crear entrada nueva.

---

## 7. Compatibilidad y migración de datos

| Origen | Destino | Estrategia |
| --- | --- | --- |
| `localStorage['storygraph-v2']` (Zustand) | `projects/<id>/project.json` | Leer una vez, escribir, verificar contadores, conservar el original |
| Dexie `storygraph-images` (Blob) | `projects/<id>/images/<id>.<ext>` | Leer blobs, escribir bytes, verificar tamaño |
| Backup `.zip` v1 (`exportBackupZip`) | `project.json` + `images/` | Es el mismo formato: se reutiliza el parser |
| Import NodeWriter (`position_x`, etc.) | `project.json` | Se conserva `parseBackupJson` / `normalizeNodeWriter` |

Contrato que **no se puede romper**:

- `parseBackupJson`, `exportBackup`, `parseBackupZip`, `exportBackupZip` deben seguir
  aceptando y produciendo el formato v1 byte-compatible.
- Antes de tocar esta lógica: crear **tests dorados** con fixtures reales.

---

## 8. Testing y CI

- **Tests de caracterización** (antes de migrar): `parseBackupJson`, `remapProject`,
  `exportBackup`, `buildEpub`, `orderFromStart`, `wouldCreateLoop`.
- Rust: `cargo test` para escritura atómica, remapeo, lectura de proyectos y migración.
- Frontend: Playwright sobre el build web (sigue disponible).
- E2E de escritorio: `tauri-driver` (limitado) o smoke tests manuales por release.
- CI: GitHub Actions con `tauri-apps/tauri-action`, matrix Windows (mínimo) y cache de Cargo.
- Firma de código: opcional al principio; sin certificado, SmartScreen advierte al instalar.

---

## 9. Métricas de éxito

| Métrica | Hoy | Objetivo |
| --- | --- | --- |
| Doble clic → ventana visible | 4–13 s | **< 1 s** (< 1,5 s aceptable) |
| Primer pintado del tablero | — | **< 1,5 s** |
| Abrir proyecto de 500 tarjetas | — | **< 200 ms** |
| Memoria con 2 ventanas | — | **< 250 MB** |
| Dependencia de Node/npm/navegador en runtime | Sí | **No** |
| Instalador | — | **5–10 MB** |

---

## 10. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
| --- | --- | --- |
| Pérdida de datos en la migración localStorage/Dexie | Alto | Escritura atómica + verificación de contadores + no borrar el origen + backups |
| Dos ventanas escribiendo el mismo proyecto | Alto | Lock por proyecto y ventana única por proyecto |
| Regresión de UI en WebView2 | Medio | WebView2 = Chromium/Edge; smoke tests de glass, filtros y animaciones |
| Pérdida del formato de backup | Alto | Tests dorados y congelar v1 como contrato |
| `App.tsx` monolítico | Medio | Refactor aparte, no mezclado con la migración |
| Builds lentos / disco lleno | Bajo | `target/` en D:, exclusiones de Defender, `cargo clean` |
| Sin `gh` CLI para PRs | Bajo | Instalar `gh` o abrir el PR desde la URL de compare |
| Firma de código ausente | Bajo | Aceptar advertencia de SmartScreen al inicio |

---

## 11. Checklist de arranque

```powershell
# 0. Estado limpio
git status
git checkout -b feat/tauri-migration

# 1. Toolchain MSVC (bloqueante)
winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
  --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# 2. Verificar enlace
rustc --version
cargo --version

# 3. Tauri CLI
npm install -D @tauri-apps/cli
npx tauri init

# 4. Desarrollo
npm run tauri dev

# 5. Release
npm run tauri build
```

`src-tauri/tauri.conf.json` (mínimo):

```json
{
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:5173",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "StoryGraph",
        "width": 1280,
        "height": 800,
        "backgroundColor": "#0b0d12"
      }
    ]
  }
}
```

---

## 12. Decisiones abiertas

- [ ] ¿Se mantiene el modo navegador como objetivo de primera clase (adaptador con fallback)?
- [ ] ¿Multi-ventana, panel de referencia, o ambos?
- [ ] ¿Codex al copiar tarjetas: reutilizar por nombre o siempre crear?
- [ ] ¿Se firma el instalador desde el primer release?
- [ ] ¿SQLite para búsqueda full-text en una fase posterior?
