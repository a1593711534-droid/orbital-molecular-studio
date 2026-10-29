# ORBITAL 計算服務部署

這個服務直接執行同一份 `chemistry.py`，保留 SMILES 檢查、生成、匯入分析、最佳化、扭轉及 E/Z 編輯功能。網站由 Sites 託管；Python／RDKit 由支援 Linux 容器的服務執行。

## 連線架構

`iPad Safari → Sites 私人網站 → Sites Worker → HTTPS Python/RDKit API`

Sites Worker 必須先檢查登入與使用權限，再呼叫此服務。瀏覽器只能呼叫網站自己的 `/api/molecule`；不可把後端網址與驗證密鑰做成使用者必填欄位，也不可將驗證密鑰放進 `VITE_*`、前端程式、URL 或 Git。

## 可部署內容

- 容器檔案：`deploy/Dockerfile`，建置內容根目錄為 App 根目錄。
- 開啟的連接埠：由平台 `PORT` 環境變數指定，預設 8000。
- 平台健康檢查：`GET /healthz`；只回傳服務狀態及版本。
- 化學 API：`POST /api/molecule`，JSON 內容與本機 API 相同。
- 受保護健康檢查：`GET /api/health`。
- API 驗證：`Authorization: Bearer <secret>`，不接受瀏覽器直接跨來源呼叫。

將 `ORBITAL_API_TOKEN` 設為至少 32 bytes 的隨機密鑰，分別保存在計算平台與 Sites 的伺服器環境變數。未設定或過短時服務拒絕啟動。密鑰只存在受保護的環境變數中，不寫入此專案。

Sites 的環境變數建議為 `CHEMISTRY_API_URL`（完整 HTTPS origin）及 `CHEMISTRY_API_TOKEN`（相同密鑰）；Worker 只轉送固定 API 路徑，不提供任意 URL 代理。

## Render 設定

1. 連接 Render 帳號與專案原始碼儲存庫。
2. 建立 Docker Web Service，Dockerfile path 使用 `./deploy/Dockerfile`，build context 使用儲存庫根目錄。
3. 設定密鑰環境變數 `ORBITAL_API_TOKEN`、`ORBITAL_CONCURRENCY=1`，健康檢查路徑 `/healthz`。
4. 部署後取得平台 HTTPS 網址，設定 Sites Worker 並驗證完整流程。

建議至少 512 MB 記憶體；同時生成大量構象時需要更多記憶體。方案費用、可用區域與冷啟動行為需在使用者帳號中確認，這份設定沒有指定付費方案或建立任何雲端資源。

同一容器亦可交給 Railway 等支援 Docker 與 HTTP 服務的平台。無需把 Windows `runtime/` 或 `python_lib/` 上傳至 Linux；Linux 套件由固定版本的 requirements 安裝。

## 執行限制

預設同時最多 1 個計算，忙碌時回傳 429；每個計算在獨立子程序執行，超過 45 秒會終止程序並回傳 504。可用 `ORBITAL_CONCURRENCY`（1–4）與 `ORBITAL_TIMEOUT_SECONDS`（1–120）調整。單次輸入上限 2 MB，傳送逾時 10 秒；不記錄輸入結構、回傳結構或驗證密鑰。

此服務不包含資料庫，使用者模型仍由前端專案存檔保存。部署後仍須實測 iPad Safari 的觸控、檔案匯入／匯出與 3D 顯示，不能用桌面視窗尺寸測試代替實機驗證。

## 驗證

在附帶 Python 的 Windows 版本可執行：

```powershell
.\runtime\python.exe -m unittest discover -s tests -p test_cloud_api.py -v
```

容器需在有 Docker 的環境另行建置驗證：

```text
docker build -f deploy/Dockerfile -t orbital-chemistry:1.2.0 .
```

2026-10-29 已通過 25 項 API 與實際 RDKit 子程序測試，涵蓋驗證、輸入限制、忙碌處理、錯誤隱藏、程序逾時終止及硝基甲烷生成。已確認固定版本在 PyPI 提供 Python 3.12／Linux x86_64 相容 wheel。本機未安裝 Docker；Linux 容器建置與平台連線仍以 Render 部署結果為準。

部署完成的判準是平台狀態成功、HTTPS 健康檢查、經 Sites 登入後成功生成及修改分子；僅產生部署檔案不代表已上線。

參考：[Render Docker 部署](https://render.com/docs/docker)、[Uvicorn 設定](https://www.uvicorn.org/settings/)。
