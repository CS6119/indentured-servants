# Giveaway draw audit

Download [the SQLite database](raffle-audit-2026-10-23.sqlite3) and open it in a SQLite viewer. This is a redacted, read-only export of the two completed draws stored when the export was made. It is not the operational database.

| Draw | Prize | Entrants | Winners |
| --- | --- | ---: | ---: |
| draw_1 | 3,280 Lunite | 9 | 3 |
| draw_2 | Monthly pass | 18 | 4 |

Discord accounts, game UIDs, and server labels have random pseudonyms consistent across both draws. The private mapping is not included. Game UIDs are normalized by removing leading zeros; server labels are trimmed and case-normalized. Entry pool positions preserve the order used by the draw query, starting at zero. Individual join timestamps are omitted.

The export contains no credentials, raw Discord IDs, game UIDs, confession data, operational logs, or unrelated member activity. Pseudonyms are not a guarantee of anonymity: public winner announcements may allow some labels to be inferred.

The records show 9 distinct game UIDs in draw_1 and 18 in draw_2, with three repeat winning Discord accounts. There were no duplicate game UIDs within either draw. The code currently enforces one entry per Discord account, not per game UID.

These are current stored records, not an independently signed snapshot captured at draw time. They do not prove historical RNG calls or exclude multiple accounts owned by one person. The source uses Node's crypto.randomInt, samples without replacement within each draw, and allows winners to enter later draws. The checksum in SHA256SUMS.txt checks file integrity only, not draw fairness.

## Queries

Entry counts and unique game UIDs:

```sql
SELECT raffle_id, COUNT(*) AS entries, COUNT(DISTINCT uid_label) AS unique_uids
FROM entries GROUP BY raffle_id;
```

Duplicate UIDs within a draw (expected: no rows):

```sql
SELECT raffle_id, uid_label, COUNT(*) AS accounts
FROM entries WHERE uid_label IS NOT NULL
GROUP BY raffle_id, uid_label HAVING COUNT(*) > 1;
```

Repeat winners across draws (expected: three rows):

```sql
SELECT participant_label, COUNT(DISTINCT raffle_id) AS draws_won
FROM winners GROUP BY participant_label
HAVING COUNT(DISTINCT raffle_id) > 1;
```

Winner entry records:

```sql
SELECT w.raffle_id, w.position, w.participant_label,
       e.uid_label, e.server_label, e.draw_pool_position
FROM winners w LEFT JOIN entries e USING (raffle_id, participant_label)
ORDER BY w.raffle_id, w.position;
```
