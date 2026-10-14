-- Additive foundation. Existing budget documents and browser records are untouched.
CREATE TABLE IF NOT EXISTS tally_financial_accounts (
  owner_id text NOT NULL REFERENCES tally_agent_workspaces(owner_id),
  currency text NOT NULL CHECK (currency IN ('INR','USD')),
  id uuid NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('bank','cash','credit_card','loan')),
  document jsonb NOT NULL,
  PRIMARY KEY (owner_id,currency,id),
  CHECK (document->>'id'=id::text AND document->>'currency'=currency AND document->>'type'=account_type)
);
CREATE TABLE IF NOT EXISTS tally_journal_events (
  owner_id text NOT NULL REFERENCES tally_agent_workspaces(owner_id),
  currency text NOT NULL CHECK (currency IN ('INR','USD')),
  id uuid NOT NULL,
  effective_date date NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('opening','income','expense','transfer','card_payment','loan_borrowing','loan_payment','refund','reversal')),
  related_event_id uuid,
  document jsonb NOT NULL,
  write_xid bigint NOT NULL DEFAULT txid_current(),
  PRIMARY KEY (owner_id,currency,id),
  FOREIGN KEY (owner_id,currency,related_event_id) REFERENCES tally_journal_events(owner_id,currency,id),
  CHECK (document->>'id'=id::text AND document->>'currency'=currency AND document->>'kind'=event_kind)
);
CREATE TABLE IF NOT EXISTS tally_journal_postings (
  owner_id text NOT NULL,
  currency text NOT NULL,
  event_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 99),
  financial_account_id uuid,
  role text CHECK (role IN ('income','expense','opening_equity')),
  category_id text,
  component text CHECK (component IN ('interest','fee')),
  side text NOT NULL CHECK (side IN ('debit','credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000000000),
  PRIMARY KEY (owner_id,currency,event_id,ordinal),
  FOREIGN KEY (owner_id,currency,event_id) REFERENCES tally_journal_events(owner_id,currency,id),
  FOREIGN KEY (owner_id,currency,financial_account_id) REFERENCES tally_financial_accounts(owner_id,currency,id),
  CHECK (num_nonnulls(financial_account_id,role)=1),
  CHECK (component IS NULL OR role='expense'),
  CHECK ((role IN ('income','expense') AND category_id IS NOT NULL) OR
         ((role IS NULL OR role='opening_equity') AND category_id IS NULL))
);
CREATE INDEX IF NOT EXISTS tally_journal_by_date ON tally_journal_events(owner_id,currency,effective_date,id);
CREATE INDEX IF NOT EXISTS tally_postings_by_account ON tally_journal_postings(owner_id,currency,financial_account_id,event_id);

-- A caller cannot append postings to an event committed in an earlier transaction.
CREATE OR REPLACE FUNCTION tally_stamp_journal_xid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.write_xid := txid_current(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS tally_stamp_journal ON tally_journal_events;
CREATE TRIGGER tally_stamp_journal BEFORE INSERT ON tally_journal_events
  FOR EACH ROW EXECUTE FUNCTION tally_stamp_journal_xid();
CREATE OR REPLACE FUNCTION tally_require_new_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tally_journal_events WHERE owner_id=NEW.owner_id
    AND currency=NEW.currency AND id=NEW.event_id AND write_xid=txid_current()) THEN
    RAISE EXCEPTION 'Postings may only be added while their new journal is being committed';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tally_new_journal_posting ON tally_journal_postings;
CREATE TRIGGER tally_new_journal_posting BEFORE INSERT ON tally_journal_postings
  FOR EACH ROW EXECUTE FUNCTION tally_require_new_journal();

-- Deferred checks see the entire posting set, including the final row.
CREATE OR REPLACE FUNCTION tally_require_balanced_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid; rows_count bigint; difference numeric;
BEGIN
  IF TG_TABLE_NAME='tally_journal_events' THEN target_id:=NEW.id; ELSE target_id:=NEW.event_id; END IF;
  SELECT count(*),coalesce(sum(CASE WHEN side='debit' THEN amount_minor ELSE -amount_minor END),0)
    INTO rows_count,difference FROM tally_journal_postings
    WHERE owner_id=NEW.owner_id AND currency=NEW.currency AND event_id=target_id;
  IF rows_count < 2 OR rows_count > 100 OR difference <> 0 THEN
    RAISE EXCEPTION 'Journal postings must balance and contain between 2 and 100 rows';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS tally_event_balance ON tally_journal_events;
CREATE CONSTRAINT TRIGGER tally_event_balance AFTER INSERT ON tally_journal_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tally_require_balanced_journal();
DROP TRIGGER IF EXISTS tally_posting_balance ON tally_journal_postings;
CREATE CONSTRAINT TRIGGER tally_posting_balance AFTER INSERT ON tally_journal_postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tally_require_balanced_journal();
