-- Phase B: append-only private evidence. Apply deliberately before enabling the feature.
CREATE TABLE tally_source_files (
 owner_id text NOT NULL REFERENCES tally_agent_workspaces(owner_id),
 currency text NOT NULL CHECK(currency IN ('INR','USD')),
 id uuid NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 mime text NOT NULL CHECK(mime IN ('text/csv','application/pdf','application/json','text/plain')),
 name text NOT NULL,
 bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 10485760),
 created_at bigint NOT NULL,
 PRIMARY KEY(owner_id,currency,id), UNIQUE(owner_id,currency,sha256)
);
CREATE TABLE tally_statements (
 owner_id text NOT NULL, currency text NOT NULL, id uuid NOT NULL,
 account_id uuid NOT NULL, source_file_id uuid NOT NULL, previous_id uuid,
 document jsonb NOT NULL,
 PRIMARY KEY(owner_id,currency,id),
 FOREIGN KEY(owner_id,currency,account_id) REFERENCES tally_financial_accounts(owner_id,currency,id),
 FOREIGN KEY(owner_id,currency,source_file_id) REFERENCES tally_source_files(owner_id,currency,id),
 FOREIGN KEY(owner_id,currency,previous_id) REFERENCES tally_statements(owner_id,currency,id) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(owner_id,currency,previous_id),
 CHECK(document->>'id'=id::text AND document->>'currency'=currency AND document->>'accountId'=account_id::text AND document->>'sourceFileId'=source_file_id::text)
);
CREATE TABLE tally_statement_observations (
 owner_id text NOT NULL, currency text NOT NULL, id uuid NOT NULL,
 account_id uuid NOT NULL, statement_id uuid NOT NULL,
 source_identity text NOT NULL CHECK(source_identity ~ '^[a-f0-9]{64}$'),
 document jsonb NOT NULL,
 PRIMARY KEY(owner_id,currency,id),
 FOREIGN KEY(owner_id,currency,account_id) REFERENCES tally_financial_accounts(owner_id,currency,id),
 FOREIGN KEY(owner_id,currency,statement_id) REFERENCES tally_statements(owner_id,currency,id),
 CHECK(document->>'id'=id::text AND document->>'currency'=currency AND document->>'statementId'=statement_id::text AND document->>'accountId'=account_id::text)
);
CREATE INDEX tally_observation_identity ON tally_statement_observations(owner_id,currency,source_identity);
CREATE TABLE tally_event_sources (
 owner_id text NOT NULL, currency text NOT NULL, id uuid NOT NULL,
 account_id uuid NOT NULL, observation_id uuid NOT NULL, event_id uuid,
 document jsonb NOT NULL,
 PRIMARY KEY(owner_id,currency,id), UNIQUE(owner_id,currency,observation_id),
 FOREIGN KEY(owner_id,currency,account_id) REFERENCES tally_financial_accounts(owner_id,currency,id),
 FOREIGN KEY(owner_id,currency,observation_id) REFERENCES tally_statement_observations(owner_id,currency,id),
 FOREIGN KEY(owner_id,currency,event_id) REFERENCES tally_journal_events(owner_id,currency,id),
 CHECK(document->>'id'=id::text AND document->>'currency'=currency AND document->>'observationId'=observation_id::text AND document->>'accountId'=account_id::text),
 CHECK((document->>'disposition'='linked' AND event_id IS NOT NULL AND document->>'eventId'=event_id::text) OR (document->>'disposition'='excluded' AND event_id IS NULL))
);
CREATE TABLE tally_reconciliations (
 owner_id text NOT NULL, currency text NOT NULL, id uuid NOT NULL,
 account_id uuid NOT NULL, statement_id uuid NOT NULL, document jsonb NOT NULL,
 PRIMARY KEY(owner_id,currency,id),
 FOREIGN KEY(owner_id,currency,account_id) REFERENCES tally_financial_accounts(owner_id,currency,id),
 FOREIGN KEY(owner_id,currency,statement_id) REFERENCES tally_statements(owner_id,currency,id),
 CHECK(document->>'id'=id::text AND document->>'currency'=currency AND document->>'statementId'=statement_id::text AND document->>'accountId'=account_id::text)
);
CREATE TABLE tally_migration_batches (
 owner_id text NOT NULL REFERENCES tally_agent_workspaces(owner_id), currency text NOT NULL CHECK(currency IN ('INR','USD')), id uuid NOT NULL,
 source_file_id uuid, document jsonb NOT NULL,
 PRIMARY KEY(owner_id,currency,id),
 FOREIGN KEY(owner_id,currency,source_file_id) REFERENCES tally_source_files(owner_id,currency,id),
 CHECK(document->>'id'=id::text AND document->>'currency'=currency)
);
CREATE TABLE tally_legacy_decisions (
 owner_id text NOT NULL, currency text NOT NULL, id uuid NOT NULL,
 batch_id uuid NOT NULL, legacy_id text NOT NULL, previous_id uuid, account_id uuid, event_id uuid, document jsonb NOT NULL,
 PRIMARY KEY(owner_id,currency,id), UNIQUE(owner_id,currency,previous_id),
 FOREIGN KEY(owner_id,currency,previous_id) REFERENCES tally_legacy_decisions(owner_id,currency,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,currency,batch_id) REFERENCES tally_migration_batches(owner_id,currency,id),
 FOREIGN KEY(owner_id,currency,account_id) REFERENCES tally_financial_accounts(owner_id,currency,id),
 FOREIGN KEY(owner_id,currency,event_id) REFERENCES tally_journal_events(owner_id,currency,id),
 CHECK(document->>'id'=id::text AND document->>'currency'=currency AND document->>'batchId'=batch_id::text AND document->>'legacyId'=legacy_id),
 CHECK((document->>'disposition'='converted' AND event_id IS NOT NULL AND document->>'eventId'=event_id::text) OR (document->>'disposition' IN ('cutoff','unassigned') AND event_id IS NULL))
);
CREATE UNIQUE INDEX tally_legacy_original_decision ON tally_legacy_decisions(owner_id,currency,batch_id,legacy_id) WHERE previous_id IS NULL;
-- The existing runtime role can only append/read evidence; no rewriting/deleting it.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tally_runtime') THEN
   GRANT SELECT,INSERT ON tally_source_files,tally_statements,tally_statement_observations,tally_event_sources,tally_reconciliations,tally_migration_batches,tally_legacy_decisions TO tally_runtime;
 END IF;
END $$;
