//! Delivery uncertainty is read from the original release owner. Host activity
//! can explain a pending export, never settle a persisted unknown outcome.
use super::*;
use crate::{DeliveryFileState, DeliveryState};

pub(super) fn project(
    _store: &ProjectStore,
    c: &Connection,
    project: ExecutionId,
    locale: Option<&str>,
    activity: &[DecisionDeliveryActivity],
) -> Result<SourceProjection, ExecutionError> {
    let page = super::super::release::project_delivery_observations_in(c, project, None, SOURCE_LIMIT)?;
    let mut items = Vec::new();
    for delivery in page.rows {
        let locales = delivery.files.iter().map(|file| file.locale.clone()).collect::<BTreeSet<_>>()
            .into_iter().collect::<Vec<_>>();
        if locale.is_some_and(|wanted| !locales.iter().any(|actual| actual == wanted)) { continue; }
        let unknown_files = delivery.files.iter().filter(|file| file.state == DeliveryFileState::Unknown).count();
        let uncertain = delivery.state == DeliveryState::Pending || delivery.state == DeliveryState::Unknown || unknown_files > 0;
        if !uncertain { continue; }
        if delivery.state == DeliveryState::Pending && activity.iter().any(|job| {
            job.kind == DecisionDeliveryJobKind::Export && job.release_id == delivery.release_id
                && job.action_id == Some(delivery.action_id)
        }) { continue; }
        let item_locale = (locales.len() == 1).then(|| locales[0].clone());
        let basis = codec::digest(&codec::encode(&(project, delivery.delivery_id, delivery.release_id,
            delivery.action_id, delivery.overwrite_conflicts, delivery.state, &delivery.files), crate::execution::MAX_INPUT_BYTES)?);
        items.push(DecisionItem {
            decision_id: format!("delivery-unknown:{}", delivery.delivery_id),
            source: DecisionSource::DeliveryUnknown,
            state: DecisionState::AwaitingRecheck,
            locale: item_locale,
            targets: vec![DecisionTarget::Delivery { release_id: delivery.release_id, delivery_id: delivery.delivery_id }],
            targets_complete: true,
            basis,
            source_action_id: Some(delivery.action_id),
            action: DecisionAction::InspectDeliveryOutcome { release_id: delivery.release_id,
                delivery_id: delivery.delivery_id, action_id: delivery.action_id },
            evidence: Some(DecisionEvidence::DeliveryOutcome { state: delivery.state, locales,
                file_count: u32::try_from(delivery.files.len())
                    .map_err(|_| failure(ErrorCode::LimitExceeded, "decision-delivery-files"))?,
                unknown_file_count: u32::try_from(unknown_files)
                    .map_err(|_| failure(ErrorCode::LimitExceeded, "decision-delivery-files"))? }),
        });
    }
    Ok(SourceProjection { items, complete: page.next.is_none() })
}

#[cfg(test)]
mod tests;
