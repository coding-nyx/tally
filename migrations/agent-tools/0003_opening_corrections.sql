-- Corrections are additional reviewed postings, never a rewrite of the opening.
ALTER TABLE tally_journal_events DROP CONSTRAINT IF EXISTS tally_journal_events_event_kind_check;
ALTER TABLE tally_journal_events ADD CONSTRAINT tally_journal_events_event_kind_check
  CHECK (event_kind IN ('opening','opening_correction','income','expense','transfer','card_payment','loan_borrowing','loan_payment','refund','reversal'));
