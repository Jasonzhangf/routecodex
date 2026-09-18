use chrono::{DateTime, Timelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

use crate::types::{
    V3ForwarderManifest, V3ForwarderTargetManifest, V3RouteGroupManifest,
    V3RoutePoolTargetManifest, V3RouteTargetKind,
};
use crate::{validation, V3ConfigError};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3ProviderPriorityScheduleAuthoringConfig {
    #[serde(default = "default_provider_priority_timezone")]
    pub timezone: String,
    #[serde(default)]
    pub peak_periods: Vec<V3DailyTimeWindowAuthoringConfig>,
    #[serde(default)]
    pub providers: Vec<V3ProviderPriorityScheduleEntryAuthoringConfig>,
}

impl Default for V3ProviderPriorityScheduleAuthoringConfig {
    fn default() -> Self {
        Self {
            timezone: default_provider_priority_timezone(),
            peak_periods: Vec::new(),
            providers: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3DailyTimeWindowAuthoringConfig {
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3ProviderPriorityScheduleEntryAuthoringConfig {
    pub provider: String,
    pub peak_tier: usize,
    pub off_peak_tier: usize,
}

impl V3ProviderPriorityScheduleAuthoringConfig {
    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }

    pub fn validate(&self, context: &str) -> Result<(), String> {
        if self.timezone.trim().is_empty() {
            return Err(format!("{context} timezone must not be empty"));
        }
        self.timezone.parse::<Tz>().map_err(|_| {
            format!(
                "{context} timezone must be a valid IANA timezone, got {:?}",
                self.timezone
            )
        })?;

        for (index, period) in self.peak_periods.iter().enumerate() {
            let start = parse_priority_schedule_minutes(&period.start).ok_or_else(|| {
                format!(
                    "{context} peak_periods[{}].start must use HH:MM (00:00-23:59)",
                    index
                )
            })?;
            let end = parse_priority_schedule_minutes(&period.end).ok_or_else(|| {
                format!(
                    "{context} peak_periods[{}].end must use HH:MM (00:00-23:59)",
                    index
                )
            })?;
            if start == end {
                return Err(format!(
                    "{context} peak_periods[{}] start and end must differ",
                    index
                ));
            }
        }

        let mut providers = BTreeSet::new();
        for entry in &self.providers {
            if entry.provider.trim().is_empty() {
                return Err(format!("{context} provider id must not be empty"));
            }
            if entry.peak_tier == 0 || entry.off_peak_tier == 0 {
                return Err(format!(
                    "{context} provider {} tiers must be positive",
                    entry.provider
                ));
            }
            if !providers.insert(&entry.provider) {
                return Err(format!(
                    "{context} contains duplicate provider {}",
                    entry.provider
                ));
            }
        }
        Ok(())
    }

    pub fn priority_for_provider(
        &self,
        provider: &str,
        base_priority: i32,
        tier_priorities: &[i32],
        now_ms: u64,
    ) -> i32 {
        let Some(entry) = self
            .providers
            .iter()
            .find(|entry| entry.provider == provider)
        else {
            return base_priority;
        };
        let tier = if self.is_peak_at(now_ms) {
            entry.peak_tier
        } else {
            entry.off_peak_tier
        };
        if tier == 0 || tier > tier_priorities.len() {
            return base_priority;
        }
        tier_priorities[tier - 1]
    }

    fn is_peak_at(&self, now_ms: u64) -> bool {
        if self.peak_periods.is_empty() {
            return false;
        }
        let Ok(timezone) = self.timezone.parse::<Tz>() else {
            return false;
        };
        let Ok(timestamp_ms) = i64::try_from(now_ms) else {
            return false;
        };
        let Some(utc) = DateTime::<Utc>::from_timestamp_millis(timestamp_ms) else {
            return false;
        };
        let local = utc.with_timezone(&timezone);
        let minute = local.hour() * 60 + local.minute();
        self.peak_periods.iter().any(|period| {
            let Some(start) = parse_priority_schedule_minutes(&period.start) else {
                return false;
            };
            let Some(end) = parse_priority_schedule_minutes(&period.end) else {
                return false;
            };
            if start < end {
                minute >= u32::from(start) && minute < u32::from(end)
            } else {
                minute >= u32::from(start) || minute < u32::from(end)
            }
        })
    }
}

pub(crate) fn validate_provider_priority_schedule_tiers(
    server_id: &str,
    route_group: &V3RouteGroupManifest,
    forwarders: &std::collections::BTreeMap<String, V3ForwarderManifest>,
    schedule: &V3ProviderPriorityScheduleAuthoringConfig,
) -> Result<(), V3ConfigError> {
    for entry in &schedule.providers {
        for pool in route_group.pools.values() {
            let mut priorities = BTreeSet::new();
            let mut contains_provider = false;
            let mut visited_forwarders = BTreeSet::new();
            for target in &pool.targets {
                collect_route_target_provider_priorities(
                    target,
                    &entry.provider,
                    forwarders,
                    &mut visited_forwarders,
                    &mut contains_provider,
                    &mut priorities,
                )?;
            }
            if !contains_provider {
                continue;
            }
            let tier_count = priorities.len();
            if entry.peak_tier > tier_count {
                return Err(validation(format!(
                    "server {server_id}.provider_priority_schedule provider {} peak tier {} exceeds route pool {} tier count {}",
                    entry.provider, entry.peak_tier, pool.id, tier_count
                )));
            }
            if entry.off_peak_tier > tier_count {
                return Err(validation(format!(
                    "server {server_id}.provider_priority_schedule provider {} off-peak tier {} exceeds route pool {} tier count {}",
                    entry.provider, entry.off_peak_tier, pool.id, tier_count
                )));
            }
        }
    }
    Ok(())
}

fn collect_route_target_provider_priorities(
    target: &V3RoutePoolTargetManifest,
    scheduled_provider: &str,
    forwarders: &std::collections::BTreeMap<String, V3ForwarderManifest>,
    visited_forwarders: &mut BTreeSet<String>,
    contains_provider: &mut bool,
    priorities: &mut BTreeSet<i32>,
) -> Result<(), V3ConfigError> {
    match target.kind {
        V3RouteTargetKind::ProviderModel => {
            if target.provider.as_deref() == Some(scheduled_provider) {
                *contains_provider = true;
            }
            priorities.insert(target.priority.unwrap_or(0));
        }
        V3RouteTargetKind::Forwarder => {
            let forwarder_id = target
                .id
                .as_deref()
                .ok_or_else(|| validation("route pool forwarder target missing id"))?;
            if !visited_forwarders.insert(forwarder_id.to_string()) {
                return Ok(());
            }
            let Some(forwarder) = forwarders
                .get(forwarder_id)
                .filter(|forwarder| forwarder.enabled)
            else {
                return Ok(());
            };
            for nested in &forwarder.targets {
                collect_forwarder_target_provider_priorities(
                    nested,
                    scheduled_provider,
                    forwarders,
                    visited_forwarders,
                    contains_provider,
                    priorities,
                )?;
            }
            visited_forwarders.remove(forwarder_id);
        }
    }
    Ok(())
}

fn collect_forwarder_target_provider_priorities(
    target: &V3ForwarderTargetManifest,
    scheduled_provider: &str,
    forwarders: &std::collections::BTreeMap<String, V3ForwarderManifest>,
    visited_forwarders: &mut BTreeSet<String>,
    contains_provider: &mut bool,
    priorities: &mut BTreeSet<i32>,
) -> Result<(), V3ConfigError> {
    match target.kind {
        V3RouteTargetKind::ProviderModel => {
            if target.provider.as_deref() == Some(scheduled_provider) {
                *contains_provider = true;
            }
            priorities.insert(target.priority.unwrap_or(0));
        }
        V3RouteTargetKind::Forwarder => {
            let forwarder_id = target
                .id
                .as_deref()
                .ok_or_else(|| validation("forwarder target missing id"))?;
            if !visited_forwarders.insert(forwarder_id.to_string()) {
                return Ok(());
            }
            let Some(forwarder) = forwarders
                .get(forwarder_id)
                .filter(|forwarder| forwarder.enabled)
            else {
                return Ok(());
            };
            for nested in &forwarder.targets {
                collect_forwarder_target_provider_priorities(
                    nested,
                    scheduled_provider,
                    forwarders,
                    visited_forwarders,
                    contains_provider,
                    priorities,
                )?;
            }
            visited_forwarders.remove(forwarder_id);
        }
    }
    Ok(())
}

pub fn default_provider_priority_timezone() -> String {
    "Asia/Shanghai".to_string()
}

fn parse_priority_schedule_minutes(value: &str) -> Option<u16> {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return None;
    }
    let hour = value.get(0..2)?.parse::<u16>().ok()?;
    let minute = value.get(3..5)?.parse::<u16>().ok()?;
    (hour < 24 && minute < 60).then_some(hour * 60 + minute)
}
