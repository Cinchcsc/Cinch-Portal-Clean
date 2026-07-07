# Request: Confirm SiteLink Reservation Status Codes

## Why we need this

We're rebuilding the "Reservations vs Scheduled Move-outs" widget on the new analytics portal using SiteLink's API. The API returns a numeric status code for each reservation (`QTRentalStatusID`), but SiteLink doesn't publish what each number means. We've pulled live data and found that of all reservations that look "still open" by date, the vast majority (about 84%) carry status code `3`, while a small minority carry code `0`. We need to know, in plain English, what these two status codes represent so we can build the correct filter — right now we can't tell if code `3` means "still open," "expired," "cancelled," or something else, and getting it wrong makes the widget's numbers wrong.

## What we need back

A plain-English label for SiteLink reservation status code **3**, and ideally also for code **0**. For example: "Cancelled," "Expired — no follow-up," "Waiting," "Converted to lease," etc. — whatever SiteLink itself calls these statuses on screen.

## Option A — Look up an individual reservation directly (fastest, if you have access)

1. Log into the SiteLink back-office / management console (not the reporting/export screen — the day-to-day operational site where staff manage tenants and leads).
2. Find the section for managing **prospects, leads, or reservations** — this is sometimes labeled "Call Center," "CRM," "Leads," or "Waiting List," depending on your SiteLink setup.
3. Search for or filter to a reservation that is a few weeks to a few months old — NOT one created today or this week. (We specifically need an *older* one, because that's where the mystery status code shows up most.)
4. Open that reservation's detail view. Look for a field labeled something like **"Status," "Rental Status,"** or **"Reservation Status."**
5. Note down exactly what text/label is shown.
6. If possible, repeat with 2-3 more reservations of different ages (one very recent, one a few weeks old, one a few months old) so we can see if the label changes as a reservation goes stale.
7. Send back: the status label shown for each reservation, and roughly how old each one was (e.g., "reservation from 3 weeks ago showed status: Cancelled").

No customer names or contact details are needed — just the status label and the rough age of the reservation.

## Option B — Pull an export if you don't have access to individual records

1. Go to the SiteLink **Reports / Export** screen (the one with checkboxes organized into "Consolidated," "Operations," "Financials," etc. — you may have seen this screen already).
2. Under the **Operations** column, check the box for **"Rental Activity."**
3. On the right side, under **Export**, select **".xlsx – Raw dataset"** (this gives every column, not a summarized report).
4. Set **Period** to "Monthly" (or the broadest option available).
5. Set the **Start** date to roughly 3 months before today, so the export captures some older records, not just this week's.
6. Click **Export** and save the file.
7. Open the file and look for a column with a name like **"Status," "RentalStatus,"** "QTRentalStatusID," or similar.
8. Send us that column along with a date column (so we can tell which rows are old vs. recent) — no need to include tenant names, emails, phone numbers, or any other personal columns; you can delete those columns before sending if you'd like.

## What NOT to send

Please don't send any tenant names, emails, phone numbers, or addresses — we only need the status code/label and a date, nothing tenant-identifying.

## Who to ask if neither option works

If neither of the above is accessible, the fastest path is to contact SiteLink support directly and ask:

> "What does `QTRentalStatusID` value `3` mean in the ReservationList API response, and what does value `0` mean?"

They maintain that field on their end and should be able to answer directly.
