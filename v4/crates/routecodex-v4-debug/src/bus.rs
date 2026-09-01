//! Read-only diagnostic event bus owned by the debug side-channel module.
//!
//! Bus behavior is deliberately observable and read-only: subscribers receive
//! immutable event facts and can never mutate control, data, or bus state.

use std::collections::BTreeSet;

use crate::DebugError;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum SubscriptionTopic {
    NodeEvent,
    StateTransition,
    Diagnostic,
    NodeEntry,
    NodeExit,
    NodeError,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subscription {
    pub subscriber_id: String,
    pub topic: SubscriptionTopic,
    pub scope_key: String,
}

/// Immutable diagnostic event envelope. It contains only observation facts;
/// control decisions and business payloads are deliberately absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiagnosticEventEnvelope {
    topic: SubscriptionTopic,
    scope_key: String,
    source_node: String,
    payload_hash: String,
}

impl DiagnosticEventEnvelope {
    /// Construct an envelope. Construction is infallible because callers that
    /// need envelope validation should build the value from typed inputs;
    /// `publish` enforces scope membership at the bus owner boundary.
    pub fn new(
        topic: SubscriptionTopic,
        scope_key: &str,
        source_node: &str,
        payload_hash: &str,
    ) -> Self {
        Self {
            topic,
            scope_key: scope_key.to_string(),
            source_node: source_node.to_string(),
            payload_hash: payload_hash.to_string(),
        }
    }

    pub fn topic(&self) -> &SubscriptionTopic {
        &self.topic
    }

    pub fn scope_key(&self) -> &str {
        &self.scope_key
    }

    pub fn source_node(&self) -> &str {
        &self.source_node
    }

    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }
}

/// Immutable published diagnostic fact. Subscribers receive read-only facts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishedEventFact {
    envelope: DiagnosticEventEnvelope,
}

impl PublishedEventFact {
    pub(crate) fn new(envelope: DiagnosticEventEnvelope) -> Self {
        Self { envelope }
    }

    pub fn envelope(&self) -> &DiagnosticEventEnvelope {
        &self.envelope
    }

    pub fn payload_hash(&self) -> &str {
        self.envelope.payload_hash()
    }
}

/// Read-only view handed to one subscriber after dispatch. It exposes only
/// published facts and cannot mutate the bus, control, or data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadOnlySubscriberView {
    subscriber_id: String,
    topic: SubscriptionTopic,
    scope_key: String,
    events: Vec<PublishedEventFact>,
}

impl ReadOnlySubscriberView {
    pub(crate) fn new(
        subscription: &Subscription,
        events: Vec<PublishedEventFact>,
    ) -> Self {
        Self {
            subscriber_id: subscription.subscriber_id.clone(),
            topic: subscription.topic.clone(),
            scope_key: subscription.scope_key.clone(),
            events,
        }
    }

    pub fn subscriber_id(&self) -> &str {
        &self.subscriber_id
    }

    pub fn topic(&self) -> &SubscriptionTopic {
        &self.topic
    }

    pub fn scope_key(&self) -> &str {
        &self.scope_key
    }

    pub fn events(&self) -> &[PublishedEventFact] {
        &self.events
    }
}

#[derive(Debug, Clone, Default)]
pub struct V4Debug02BusSubscription {
    subscriptions: Vec<Subscription>,
    disposed: BTreeSet<String>,
    published: Vec<PublishedEventFact>,
}

impl V4Debug02BusSubscription {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscribe(
        &mut self,
        subscriber_id: &str,
        topic: SubscriptionTopic,
        scope_key: &str,
    ) -> Result<(), DebugError> {
        let duplicate = self.subscriptions.iter().any(|existing| {
            existing.subscriber_id == subscriber_id
                && existing.topic == topic
                && existing.scope_key == scope_key
        });
        if duplicate {
            return Err(DebugError::DuplicateSubscription);
        }
        if self.disposed.contains(subscriber_id) {
            return Err(DebugError::DisposedSubscriber);
        }
        self.subscriptions.push(Subscription {
            subscriber_id: subscriber_id.to_string(),
            topic,
            scope_key: scope_key.to_string(),
        });
        Ok(())
    }

    pub fn subscribers_for<'a>(
        &'a self,
        topic: &'a SubscriptionTopic,
    ) -> impl Iterator<Item = &'a Subscription> {
        self.subscriptions.iter().filter(move |subscription| {
            !self.disposed.contains(&subscription.subscriber_id)
                && &subscription.topic == topic
        })
    }

    pub fn subscription_count(&self) -> usize {
        self.subscriptions.len()
    }

    pub fn publish(
        &mut self,
        envelope: DiagnosticEventEnvelope,
    ) -> Result<PublishedEventFact, DebugError> {
        let fact = PublishedEventFact::new(envelope);
        self.published.push(fact.clone());
        Ok(fact)
    }

    pub fn dispatch(
        &self,
        topic: &SubscriptionTopic,
        scope_key: &str,
    ) -> Result<Vec<ReadOnlySubscriberView>, DebugError> {
        if !self
            .subscriptions
            .iter()
            .any(|subscription| subscription.scope_key == scope_key)
        {
            return Err(DebugError::UnknownScope);
        }
        let facts = self
            .published
            .iter()
            .filter(|fact| {
                fact.envelope().topic() == topic && fact.envelope().scope_key() == scope_key
            })
            .cloned()
            .collect::<Vec<_>>();
        Ok(self
            .subscriptions
            .iter()
            .filter(|subscription| {
                !self.disposed.contains(&subscription.subscriber_id)
                    && &subscription.topic == topic
                    && subscription.scope_key == scope_key
            })
            .filter_map(|subscription| {
                if facts.is_empty() {
                    None
                } else {
                    Some(ReadOnlySubscriberView::new(subscription, facts.clone()))
                }
            })
            .collect())
    }

    pub fn published_facts(&self) -> &[PublishedEventFact] {
        &self.published
    }

    pub fn subscriber_view(
        &self,
        subscriber_id: &str,
    ) -> Result<ReadOnlySubscriberView, DebugError> {
        let subscription = self
            .subscriptions
            .iter()
            .find(|subscription| subscription.subscriber_id == subscriber_id)
            .ok_or(DebugError::UnknownSubscription)?;
        if self.disposed.contains(subscriber_id) {
            return Err(DebugError::DisposedSubscriber);
        }
        let events = self
            .published
            .iter()
            .filter(|fact| {
                fact.envelope().topic() == &subscription.topic
                    && fact.envelope().scope_key() == subscription.scope_key
            })
            .cloned()
            .collect();
        Ok(ReadOnlySubscriberView::new(subscription, events))
    }

    pub fn dispose(&mut self, subscriber_id: &str) -> Result<(), DebugError> {
        if !self
            .subscriptions
            .iter()
            .any(|subscription| subscription.subscriber_id == subscriber_id)
        {
            return Err(DebugError::UnknownSubscription);
        }
        if !self.disposed.insert(subscriber_id.to_string()) {
            return Err(DebugError::DisposedSubscriber);
        }
        Ok(())
    }
}
