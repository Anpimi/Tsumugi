//! Capacity-only table replacement. The original transaction, backup and
//! version gates remain owned by ProjectStore; no capture bytes are rewritten.
use rusqlite::Connection;
use std::borrow::Cow;

const TABLES: [(&str, &str); 4] = [
    ("source_sets", "set_id,project_id,payload,digest"),
    (
        "source_files",
        "artifact_id,set_id,logical_path,role,bytes,digest",
    ),
    (
        "execution_attempts",
        "attempt_id,task_id,project_id,previous_attempt_id,input,digest,cancellation_revision,sequence",
    ),
    (
        "execution_results",
        "result_id,attempt_id,item_id,dispatch_token,bytes,digest",
    ),
];

pub(super) fn schema_sql<'a>(name: &str, current: &'a str, version: i64) -> Cow<'a, str> {
    if !(61..=75).contains(&version) {
        return Cow::Borrowed(current);
    }
    let old = match name {
        "source_sets" => current.replace("4194304", "1048576"),
        "source_files" => current.replace("2097152", "1048576"),
        "execution_attempts" => current.replace("147456", "18432"),
        "execution_results" => current.replace("33554432", "8388608"),
        _ => return Cow::Borrowed(current),
    };
    Cow::Owned(old)
}

fn rebuild(connection: &Connection, version: i64) -> rusqlite::Result<()> {
    if connection.is_autocommit() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    connection.execute_batch("PRAGMA defer_foreign_keys=ON")?;
    for (name, columns) in TABLES {
        let current = super::content::TABLES
            .iter()
            .chain(super::ledger::TABLES)
            .find(|(table, _)| *table == name)
            .ok_or(rusqlite::Error::InvalidQuery)?
            .1;
        let ddl = schema_sql(name, current, version);
        // The identifiers are a closed roster above. Keep original rowid gaps,
        // bytes, digests and foreign-key targets rather than reserializing rows.
        connection.execute_batch(&format!(
            "CREATE TEMP TABLE capacity_rows AS SELECT rowid AS retained_rowid,{columns} FROM {name};
             DROP TABLE {name}; {ddl};
             INSERT INTO {name}(rowid,{columns}) SELECT retained_rowid,{columns} FROM capacity_rows;
             DROP TABLE capacity_rows;"
        ))?;
        #[cfg(test)]
        super::migration_crash_hook(&format!("capacity-after-{name}"));
    }
    if connection.prepare("PRAGMA foreign_key_check")?.exists([])? {
        return Err(rusqlite::Error::InvalidQuery);
    }
    connection.execute_batch("PRAGMA defer_foreign_keys=OFF")?;
    Ok(())
}

pub(super) fn migrate(connection: &Connection) -> rusqlite::Result<()> {
    rebuild(connection, 76)
}

#[cfg(test)]
pub(in crate::persistence) fn make_legacy_schema(connection: &Connection) -> rusqlite::Result<()> {
    let tx = connection.unchecked_transaction()?;
    rebuild(&tx, 75)?;
    tx.commit()
}

#[cfg(test)]
mod tests;
