# flow-mcp — fork DKE

Fork dari [GTAI-1/flow-mcp](https://github.com/GTAI-1/flow-mcp) dengan perbaikan yang dipakai tim DKE. Panduan umum ada di
[README.md](README.md); berkas ini hanya memuat yang berbeda dan aturan pakai di tim.

> **Repo ini PUBLIK.** Jangan commit token, `.env`, kunci API, email akun, atau hasil/aset klien.

## Yang berbeda dari upstream

| perbaikan | berkas | efek |
|---|---|---|
| Anti-unggahan dobel | `src/dedup.ts`, `src/flow.ts` | File yang isinya sama (sha256) tidak diunggah ulang ke project Flow yang sama; aset lama dipasang lagi. `scene-NN.*` hasil unduhan dipasang dari tile aslinya. Sebelumnya 46 dari 124 unggahan ternyata kembar. |
| Anti-gambar dobel | `src/dedup.ts`, `src/core.ts` | Permintaan gambar yang sama persis (prompt, model, rasio, referensi) mengembalikan gambar lama dengan status `done` dan note "already in this project", tanpa job ke Flow. Untuk take baru: `regenerate: true` per scene. |
| Pemilih aset lama | `src/flow.ts` (`attachAsset`) | Mencari lewat kotak "Search assets", lalu menggulir daftar virtual sampai aset muncul. Nama harus cocok persis (`scene-04` tidak mengambil `scene-04-v1`). |
| Jeda gambar terpisah | `src/queue.ts` | `FLOW_MCP_IMAGE_PAUSE_MIN_S` dan `FLOW_MCP_IMAGE_PAUSE_MAX_S` untuk still; video tetap memakai `FLOW_MCP_PAUSE_*`. |

Uji cepat setelah build: `node dist/dedup.js --cek` harus mencetak `dedup ok`.

## Pasang di host baru

```bash
git clone https://github.com/DKE-IT-Developer/flow-mcp.git ~/tools/flow-mcp
cd ~/tools/flow-mcp && npm install && npm run build && node dist/dedup.js --cek
npm run login      # Chrome khusus Flow → login Google → buka project Flow, biarkan jendela terbuka
claude mcp add --scope user flow \
  -e FLOW_MCP_PAUSE_MIN_S=90 -e FLOW_MCP_PAUSE_MAX_S=180 \
  -e FLOW_MCP_IMAGE_PAUSE_MIN_S=30 -e FLOW_MCP_IMAGE_PAUSE_MAX_S=60 \
  -- node ~/tools/flow-mcp/dist/index.js
```

Tambahkan `-e FLOW_MCP_PORT=<port kosong>` bila port bawaan 8787 sudah dipakai layanan lain (gejala: flow-mcp crash saat start
dengan `Unexpected end of JSON input`). Tambahkan juga `-e FLOW_MCP_OUTPUT=<folder hasil>` sesuai kebutuhan.

## Aturan pakai di tim

- **Satu akun Google = satu host aktif.** Kredit dan batas aktivitas Flow dihitung per akun. Jangan menjalankan antrean dari dua
  host dengan akun yang sama secara bersamaan.
- **Jeda video 90–180 dtk, batch ≤ 15 job.** Setelah sekitar 75 job dalam 5 jam, Flow menolak klip dengan pesan "unusual
  activity". Kalau muncul, berhenti dan tunggu beberapa jam, lalu coba 1 job dulu. Jangan retry massal.
- **Catat saldo sebelum dan sesudah** setiap tahap berbayar (`flow_status` dengan `detailed: true`). Saldo pernah turun lebih
  banyak dari quote.
- **Ledger anti-dobel berlaku per host** (`$FLOW_MCP_HOME/uploads.json` dan `images.json`, bawaan `~/.flow-mcp`). Host lain belum
  tahu unggahan host ini, jadi file yang sama bisa terunggah sekali lagi.
- **Referensi yang sudah ada di Flow** pakai `asset:<nama>`, bukan path, kalau namanya diketahui.
- **Video Omni dengan `first_frame`:** jangan kirim `duration`. Tanpa `duration`, klipnya 8 dtk.

## Update dari upstream

```bash
git pull upstream main     # remote: git remote add upstream https://github.com/GTAI-1/flow-mcp.git
npm install && npm run build && node dist/dedup.js --cek
git push
```

Selesaikan konflik dengan mempertahankan perbaikan di tabel di atas. Jangan `git reset` atau `checkout` ke upstream, karena
patch DKE akan hilang. Restart server flow-mcp hanya saat tidak ada job yang `running`, karena antrean di memori ikut terbuang.
