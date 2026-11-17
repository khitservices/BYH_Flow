-- 016_programme_blocks.sql — a client can book a block of sessions, then further blocks, or a standalone session.
-- Each block is distinct (own programme name, session count, price, history); one is current at a time.
-- clients.programme_* stays as a copy of the CURRENT block so existing pages keep working; appointments say which block they belong to.
CREATE TABLE clinical.programme_blocks (
  id                  BIGSERIAL PRIMARY KEY,
  client_id           BIGINT NOT NULL REFERENCES clinical.clients(id) ON DELETE CASCADE,
  number              INTEGER NOT NULL,
  programme_id        BIGINT REFERENCES core.programmes(id),
  name                TEXT,
  sessions            INTEGER NOT NULL CHECK (sessions BETWEEN 1 AND 60),
  price_pence         INTEGER,
  sessions_before_app INTEGER NOT NULL DEFAULT 0,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at            TIMESTAMPTZ,
  UNIQUE (client_id, number)
);
CREATE INDEX programme_blocks_client_idx ON clinical.programme_blocks (client_id);
ALTER TABLE clinical.clients      ADD COLUMN current_block_id BIGINT REFERENCES clinical.programme_blocks(id);
ALTER TABLE clinical.appointments ADD COLUMN block_id BIGINT REFERENCES clinical.programme_blocks(id);
CREATE INDEX appointments_block_idx ON clinical.appointments (block_id);

-- One block for everyone who already has a programme (their current one; earlier fresh programmes were not kept as rows).
INSERT INTO clinical.programme_blocks (client_id, number, programme_id, name, sessions, price_pence, sessions_before_app, started_at)
SELECT id, programme_number, programme_id, programme_name, programme_sessions, programme_price_pence, sessions_before_app, programme_started_at
  FROM clinical.clients WHERE programme_sessions IS NOT NULL;
UPDATE clinical.clients c SET current_block_id = b.id FROM clinical.programme_blocks b WHERE b.client_id = c.id;
UPDATE clinical.appointments a SET block_id = c.current_block_id FROM clinical.clients c WHERE c.id = a.client_id;
