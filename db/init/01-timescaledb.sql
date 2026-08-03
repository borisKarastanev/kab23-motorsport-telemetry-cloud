-- Enable the TimescaleDB extension on the domain database. Telemetry
-- hypertables (Phase 2) are created on top of this same engine, so there is a
-- single database to operate and back up.
CREATE EXTENSION IF NOT EXISTS timescaledb;
