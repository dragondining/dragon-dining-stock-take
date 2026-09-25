# Dragon Dining Stock Take

Monthly stock take for Harbour View Services at Yokohama International School. One kitchen, including the cafe, shop, and sheds. Staff count rooms in any order with a barcode scanner.

This is not a till, not recipes, and not purchasing. There is no Receive, Use, or Move screen.

## Run it

Node.js 22.13 or newer is required. Node 24 is fine.

```powershell
cd "C:\Users\pagej\Dragon_Dining App\stock-take"
npm install
npm start
```

Open http://127.0.0.1:8787 on this computer. The server listens only on this machine. Other devices on the Wi-Fi cannot open it.

The screens follow the PackSplit layout: a narrow column, a frosted header, and tabs along the bottom, in red instead of blue.

The first start reads `Starter Files\Inventory_for_Grok_MVP.xlsx` when the database is empty. The Dragon Dining catalog is the real data. The app does not replace it with sample groceries.

The database file is `data\stocktake.sqlite`.

## Manager PIN

The PIN starts as **1234**. Change it under Manager → Change PIN. Use 4 to 8 digits.

The PIN is required to edit items, replace the catalog, move an item's room, and finish a stock take. Linking a barcode to an item that already exists does not need the PIN, so a count is not stuck on an unknown code.

## Scanner

Use a USB or Bluetooth scanner that types like a keyboard and sends Enter at the end of the code (HID keyboard wedge).

1. Open a room.
2. Tap **Scan barcode** once if the cursor is not already there.
3. Scan. With **Tally on** (the default), each scan adds 1. The count is saved on that item even if you are standing in a different room.
4. The cursor stays in the box for the next scan.

Tally on or off is remembered on that device. Tally off opens a keypad so you can type a quantity, including decimals. **0** means none of that item. **Clear count** puts the item back to "still to count".

The camera button is optional. It needs a browser that can read barcodes from the camera, and a secure page (this computer's localhost, or https). A scanner does not need the camera. If the camera is blocked, counting still works.

## Offline

Open the app once on each phone or tablet while the kitchen computer is running. After that, a count is saved on the device first.

If the network drops, including in a walk-in, the count stays on the device. The status says **Waiting to sync**. It does not say the count was lost. When the device can reach the computer again, the count is sent.

Two people saving the same item: the latest quantity wins. Tally adds 1 on that device's screen. It is not added again on the server as a second +1 from another device.

## Import

Manager → Import catalog.

- **Merge** updates items and adds new ones. It does not delete items that are missing from the file, and it does not combine two items that share a name.
- **Replace** rebuilds the catalog from the file. Type `REPLACE`. If a count is in progress, tick **Abandon the open count** as well. Replace will not throw away an open count unless you do that.
- **Download catalog** saves a CSV you can edit and merge back. The extra `fingerprint` column lets a merge find the same item again.

Spreadsheet cleanup (duplicate ids, yen text such as `¥1,309`, `No Barcode`, trailing `.0` on codes, `walk-in fridge` / `Walk-In Freezer`, blank room → Unassigned) is reported on the import screen. A barcode that appears on two different items is not attached to either one. The report names them so a manager can choose.

## Finish

Manager → Finish stock take. The name starts as the current month in Japan. Finishing:

- freezes quantities and costs into an archive
- downloads a CSV
- clears quantities
- keeps the items

Editing a cost later does not change an archive. Past stock takes can be downloaded again from Manager → Past stock takes.

Stock value is quantity times unit cost, rounded to the nearest yen. Lines with no cost are counted, and they add nothing to the yen total. Selling price is stored separately and is not used in the value.

## Online (GitHub, Vercel, Supabase)

The phone site uses Supabase for the data and Vercel for the pages. This PC can still run `npm start` on its own SQLite file.

1. In Supabase, open **SQL Editor**, paste `supabase/schema.sql`, and run it.
2. Open **Project Settings → Database → Connection string**, choose **Session pooler**, and copy the URI.
3. In PowerShell, from this folder, copy the catalog once. Replace the URI with yours. Do not commit it.

```powershell
$env:SUPABASE_DB_URL = "postgresql://..."
node scripts/copy-to-supabase.mjs
```

4. On GitHub, create a **private** repository named `dragon-dining-stock-take`. Do not add a README there.
5. From this folder:

```powershell
git remote add origin https://github.com/YOUR_NAME/dragon-dining-stock-take.git
git push -u origin main
```

6. In Vercel, choose **Add New → Project**, import that repository, and leave the framework as Other.
7. Add one environment variable: `SUPABASE_DB_URL`, the same session-pooler URI. Deploy.
8. Open the `*.vercel.app` link. Change the manager PIN from **1234** before anyone else uses it.

The service role key stays unused by the browser. Do not put it in the site.

## Checks

```powershell
npm test
```
