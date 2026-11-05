/**
 * demo.js
 *
 * Sample Community Group for the CG page's demo mode (/cg/CODE?demo): eight
 * made-up members, each with survey answers, written as Responses rows so the
 * real processor turns them into results. Every number on the demo page is
 * then out of the people it shows. Nothing here touches the Sheet.
 */

import { emailKey } from './sync-pc.js';

// [email, survey row]
const MEMBERS = [
  ['maria@example.com', {
    heartbeat_1: 'Children & Education', heartbeat_2: 'Immigrants & Refugees', heartbeat_3: 'Poverty & Economic Opportunity',
    vocation_1: 'Education', vocation_2: 'Nonprofit & Social Services',
    connect_1_place: 'Mexico', connect_1_city: 'Guadalajara', connect_2_place: 'Region: Latin America',
  }],
  ['james@example.com', {
    heartbeat_1: 'Children & Education', heartbeat_2: 'Human Trafficking',
    vocation_1: 'Software & Product', vocation_2: 'AI & Data',
    connect_1_place: 'Region: East & Southeast Asia', connect_2_place: 'Philippines', connect_2_city: 'Manila',
  }],
  ['sarah@example.com', {
    heartbeat_1: 'Hunger & Clean Water', heartbeat_2: 'Children & Education',
    vocation_1: 'Healthcare & Mental Health', vocation_2: 'Education',
    connect_1_place: 'Kenya', connect_2_place: 'Philippines',
  }],
  ['dan@example.com', {
    heartbeat_1: 'Homelessness & Housing', heartbeat_2: 'Children & Education', heartbeat_3: 'Foster Care & Family',
    vocation_1: 'Church & Ministry', vocation_2: 'Education',
    connect_1_place: 'Kenya', connect_1_city: 'Nairobi', connect_2_place: 'United States',
  }],
  ['alex@example.com', {
    heartbeat_1: 'Poverty & Economic Opportunity', heartbeat_2: 'Children & Education',
    vocation_1: 'Business & Finance', vocation_2: 'Software & Product',
    connect_1_place: 'China', connect_1_city: 'Shanghai', connect_2_place: 'Region: East & Southeast Asia',
  }],
  ['nina@example.com', {
    heartbeat_1: 'Foster Care & Family', heartbeat_2: 'Homelessness & Housing',
    vocation_1: 'Healthcare & Mental Health', vocation_2: 'Nonprofit & Social Services',
    connect_1_place: 'Region: Latin America', connect_2_place: 'Costa Rica',
  }],
  ['chris@example.com', {
    heartbeat_1: 'Homelessness & Housing', heartbeat_2: 'Justice & Human Rights',
    vocation_1: 'Law, Government & Policy', vocation_2: 'Business & Finance',
    connect_1_place: 'Mexico', connect_1_city: 'Mexico City', connect_2_place: 'United States',
  }],
  ['hannah@example.com', {
    heartbeat_1: 'Children & Education', heartbeat_2: 'Immigrants & Refugees',
    vocation_1: 'Software & Product', vocation_2: 'Arts, Media & Design',
    connect_1_place: 'Region: Middle East', connect_2_place: 'Thailand', connect_2_city: 'Bangkok',
  }],
];

export const DEMO_MEMBER_COUNT = MEMBERS.length;

/** The first `joined` members, newest first, and their Responses rows. */
export function demoGroup(joined) {
  const present = MEMBERS.slice(0, Math.max(0, Math.min(joined, MEMBERS.length)));
  const responses = present
    .map(([email, row], i) => ({
      person_id: `demo-${i}`,
      submitted_at: '2026-11-01T19:00:00Z',
      is_test: 'FALSE',
      email_key: emailKey(email),
      ...row,
    }));
  const members = present.map(([email]) => ({ email })).reverse();
  return { responses, members };
}
