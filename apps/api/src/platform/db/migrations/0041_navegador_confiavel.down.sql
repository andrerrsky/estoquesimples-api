DROP INDEX IF EXISTS admin_sessions_trusted_device_idx;
ALTER TABLE admin_sessions DROP COLUMN IF EXISTS trusted_device_id;
DROP INDEX IF EXISTS admin_trusted_devices_admin_idx;
DROP TABLE IF EXISTS admin_trusted_devices;
