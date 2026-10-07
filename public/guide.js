export function guideHtml() {
  return `
    <h2>Monthly stock take</h2>
    <p>Dragon Dining counts stock once each calendar month. The count is a snapshot of what is on hand when the manager closes it. It is a monthly count, and the quantities do not carry forward.</p>
    <p><strong>When.</strong> Count once each month, after service, while the stock is still in the rooms. The count can take more than one day. The manager closes it when the count should be closed. The file is named for that month, such as September 2026.</p>
    <p><strong>Who.</strong> Staff count with their own usernames, on a phone, tablet, or computer. A manager checks that every device has finished saving, then closes the month. Only a manager can close the count and start the next one. Share the staff logins for counting. Keep the manager login for closing the month and for the catalog.</p>
    <h3>During the month</h3>
    <ol>
      <li>Sign in at https://dragon-dining-stock-take.vercel.app.</li>
      <li>On Home, open a room. Rooms can be counted in any order.</li>
      <li>Leave <strong>Tally on</strong>. Each scan adds one. The button starts on each time the app is opened.</li>
      <li>Scan the barcode. Each scan adds one. Tap the quantity on the strip to type any number, including a partial such as 0.5. Minus and plus change it by one.</li>
      <li>On a phone or a computer, tap <strong>Use camera</strong>. Fill the box with the barcode and hold it steady.</li>
      <li>For an empty shelf, turn <strong>Tally off</strong>, tap the item, and enter <strong>0</strong>, or leave it uncounted. An item nobody counted is treated as zero when the manager closes the month.</li>
      <li>Home still shows those items as not counted, so the rooms make it clear what has been completed. Enter a number when you have checked the shelf.</li>
      <li>Watch the top of the screen. <strong>Waiting to sync</strong> means this device still holds counts. <strong>All counts saved</strong> means they are on the server. Check each phone, tablet, and computer.</li>
      <li>Home shows “X of X counted” for the whole kitchen, and each room has its own bar. Yen stays off these screens.</li>
    </ol>
    <h3>Close the month</h3>
    <p>Only a manager can do this. Staff do not see Finish stock take. Close the count when it should be closed. That can be a later day than the day counting started.</p>
    <ol>
      <li>Every phone, tablet, and computer shows <strong>All counts saved</strong>. A device that still says <strong>Waiting to sync</strong> has counts that are not in the file yet.</li>
      <li>A manager opens <strong>Manager → Finish stock take</strong>.</li>
      <li>The name is already the current month, such as September 2026. Leave it, unless this is a second close in the same month. A second close needs its own name, such as September 2026 recount, so the two files stay distinct.</li>
      <li>Read the value. It is the yen total of items that have a cost. An item with no cost stays in the file with a blank value and is not in the total.</li>
      <li>Tap <strong>Finish stock take</strong>. The app asks: “This will reset the counts to zero. Are you sure?”</li>
      <li>Confirm. The app saves the month, downloads a CSV, and clears every quantity. Items nobody counted are saved as quantity 0. The items, barcodes, rooms, and costs stay.</li>
      <li>The file name looks like <strong>Dragon-Dining-September-2026.csv</strong>. Save that file with the school’s stock-take records.</li>
      <li>The app opens <strong>Past stock takes</strong>. If the download was blocked, tap <strong>Download CSV</strong> on that month. The same file can be downloaded again later.</li>
    </ol>
    <p>The CSV lists every active item. Columns are room, supplier, name, stock unit, pack qty, item size, unit of measure, quantity, unit cost, line value, barcodes, note, and exception. Quantity is 0 when nobody entered a count. The last row is <strong>TOTAL</strong>.</p>
    <h3>The next month</h3>
    <p>The next month starts as soon as Finish succeeds. Every item is uncounted again. Home goes back to “0 of X counted”. Staff count again when the next month’s count begins. Keep each month’s file. Each Finish makes a new archive with its own name.</p>
    <p><strong>Finish stock take</strong> is the way to separate one month from the next. <strong>Import catalog → Replace catalog</strong> deletes the open quantities and does not save the CSV. Leave Replace for a manager who is rebuilding the item list from a spreadsheet.</p>
    <h2>Sign in and sign out</h2>
    <p>Open https://dragon-dining-stock-take.vercel.app. Enter the username and password. <strong>Sign out</strong> is at the top right of every page.</p>
    <p>The form appears right away. The first sign-in after the site has been idle can take a few seconds while the database wakes up.</p>
    <h2>Counting</h2>
    <ul>
      <li><strong>Tally on</strong> adds one for each scan. <strong>Tally off</strong> opens a keypad so you can type the quantity, including 0.</li>
      <li>Tap an item in the list to set its quantity. <strong>Clear count</strong> puts it back on Still to count.</li>
      <li><strong>Still to count</strong> and <strong>Counted</strong> split the room. Search finds an item by name.</li>
      <li>The strip under a scan has minus, the quantity, and plus. Tap the quantity to type any number, including a partial such as 0.5. The next scan adds one.</li>
      <li>A barcode with no item opens <strong>Unknown barcode</strong>. Type the item name and tap that row. The code is added even when the item already has a barcode. Scanning any of an item’s barcodes counts that same item. Tap <strong>Create a new item</strong> only when the product is not in the list: enter the name, room, and cost in yen, then <strong>Save and count</strong>. <strong>Skip for now</strong> leaves a banner until someone names it. <strong>Forget this barcode</strong> drops it.</li>
      <li>Two people saving the same item: the latest save is the one kept.</li>
      <li>A phone, tablet, or computer can keep counting if the network drops. Those counts stay on that device until <strong>All counts saved</strong> appears.</li>
    </ul>
    <h2>Manager: People</h2>
    <p>Open <strong>Manager → People</strong>. This list is only for a manager.</p>
    <h3>Add a person</h3>
    <ol>
      <li>Username: 2 to 32 letters, numbers, dots, or dashes. Example: yuki.</li>
      <li>Password: at least 8 characters.</li>
      <li>Permission: <strong>Staff — count and add unknown items</strong>, or <strong>Manager</strong>.</li>
      <li>Tap <strong>Add person</strong>.</li>
    </ol>
    <p>They sign in with that username and password. Staff can count and can add an item when a barcode is unknown. A manager can open the whole Manager menu. Keep at least one manager. The app will refuse to turn the last manager into staff.</p>
    <h3>Change a person</h3>
    <ul>
      <li>Change the permission dropdown and tap <strong>Save permission</strong>.</li>
      <li>Type a new password and tap <strong>Set password</strong>. The new password replaces the old one.</li>
    </ul>
    <p>People have no delete button. To retire a login, set a new password so the old one stops working, and set the permission to Staff if they should not manage the catalog.</p>
    <h2>Manager: items, lists, and rooms</h2>
    <p><strong>Items and barcodes.</strong> Edit the row, then <strong>Save</strong>. <strong>Add item</strong> puts a new item on the list. Name and room are required. Supplier, Unit, and UoM are dropdowns. Cost is the yen used for the stock value. A barcode can be left blank. An item can have more than one barcode. They are shown together on the row. Scanning any of them counts that item. A barcode stays on only one item. Add or remove a code in that box, then <strong>Save</strong>. Hide keeps an item off the counting lists. <strong>Delete</strong> removes the item, its barcodes, and this month’s count. Delete is on this list only. A finished month still shows the item as it was when that month was closed.</p>
    <p><strong>Suppliers, Stock units, and Measures</strong> are three menus. Stock unit is what you count, such as Pack, Bottle, or Can. Measure is the size unit, such as g, kg, ml, or L. Add a name, rename it, or hide it. A rename updates items that use the old name. Hide is refused while an item still uses that name.</p>
    <p><strong>Rooms.</strong> Add a room, rename it, or hide it. Hidden rooms leave the Home list.</p>
    <p><strong>Import catalog.</strong> <strong>Merge</strong> adds and updates items from an Excel or CSV file. <strong>Download catalog</strong> saves the current item list, without quantities. <strong>Replace catalog</strong> rebuilds the item list from the file. It asks you to type REPLACE. If a count is open, it also asks you to abandon that count. Abandon deletes the quantities and does not write the monthly CSV. Use Finish stock take to close a month.</p>
    <p><strong>Past stock takes.</strong> Each finished month is listed with its date, how many items were counted, and the yen total. <strong>Download CSV</strong> saves that month again.</p>`
}

export function faqHtml() {
  return `
    <p><strong>When do we count?</strong> Once each calendar month. Counting can take more than one day. The manager closes the count when it should be closed.</p>
    <p><strong>Who can start the next month?</strong> Only a manager. Finish stock take asks: “This will reset the counts to zero. Are you sure?” Staff cannot close the count.</p>
    <p><strong>How does a new month start?</strong> A manager opens Finish stock take, checks the month name, and confirms the warning. The app downloads the CSV, stores the month under Past stock takes, and clears the quantities. The next count starts from zero.</p>
    <p><strong>Where is last month’s file?</strong> Manager → Past stock takes → Download CSV. Also keep the file that downloaded at Finish.</p>
    <p><strong>What if nobody counted an item?</strong> It is saved as quantity 0. During the count it still shows under Still to count, so the team can see what has not been completed.</p>
    <p><strong>What does the total mean?</strong> It is the yen value of items that have a cost. An item with no cost is in the file with a blank value and is left out of the total. An item nobody counted is quantity 0, so it adds nothing to the total.</p>
    <p><strong>Can two months share one file?</strong> Each Finish writes one archive. Use the month name once. A second close in the same month needs a different name, such as September 2026 recount.</p>
    <p><strong>A device says Waiting to sync.</strong> Those counts are still on that phone, tablet, or computer. Wait until every device says All counts saved before the manager finishes the month.</p>
    <p><strong>Tally is off.</strong> It starts on each time the app is opened. Tap <strong>Tally on</strong> before scanning. Tally off is for typing a quantity.</p>
    <p><strong>I scanned in the wrong room.</strong> The count is still saved, on the room filed for that item. The strip shows that room.</p>
    <p><strong>The barcode is unknown.</strong> Type the item name and tap the row already in the list. Do this whether that item has a barcode or not. The new code is added beside any code already there. Scanning either code counts that item. Create a new item only when the product is not in the list. Staff can do this. Skip for now leaves a banner on Home.</p>
    <p><strong>Can one item have more than one barcode?</strong> Yes. The same product sometimes arrives with a different code. Link the unknown code to that item, or a manager adds it on the Items row and taps Save. A barcode cannot be on two items.</p>
    <p><strong>How do I remove an item?</strong> A manager opens Items and barcodes and taps <strong>Delete</strong> on that row, then confirms. Hide keeps the item off the counting lists. Delete removes it. Staff cannot delete an item. A finished month is not changed.</p>
    <p><strong>I cannot open Manager.</strong> That login is staff. Staff count and add unknown items. A manager changes the permission under Manager → People.</p>
    <p><strong>How do I add a person?</strong> Manager → People. Enter a username, a password of at least 8 characters, and Staff or Manager. They sign in with that username.</p>
    <p><strong>Someone forgot a password.</strong> A manager opens their card, types a new password, and taps Set password.</p>
    <p><strong>Can I remove a person?</strong> There is no delete button. Set a new password so the old one stops working.</p>
    <p><strong>Where are the yen amounts?</strong> On the manager screens: the items table, Finish stock take, and Past stock takes. Counting screens show progress only.</p>
    <p><strong>I finished and no file downloaded.</strong> Open Past stock takes and tap Download CSV for that month.</p>
    <p><strong>What is Download catalog?</strong> It is the item list, with no quantities. The monthly count is the CSV from Finish stock take or Past stock takes.</p>
    <p><strong>The page looks old.</strong> Hard-refresh https://dragon-dining-stock-take.vercel.app after a manager says an update is ready.</p>`
}
