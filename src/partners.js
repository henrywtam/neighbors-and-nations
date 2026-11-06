/**
 * partners.js
 *
 * Supported missionaries and global partners, kept in a Partners tab that Justice & Outreach
 * edits. The tab is created (and filled with the starting list below) the
 * first time the app runs; after that the Sheet is the source of truth and is
 * re-read on the reference refresh interval.
 *
 * Partners tab columns:
 *   name        shown as written
 *   kind        Partner | Missionary
 *   org         a missionary's organization, e.g. Cru
 *   side        Local | Global | Both
 *   heartbeats  survey heartbeat labels, separated by " | "
 *   countries   country names (as in countries.json), separated by " | "
 *   region      one Regions-tab region; blank for local or worldwide
 *   skills      survey vocation labels the partner could use, separated by " | "
 *   place       short location text for the page
 *   description one or two sentences for the page
 *   sensitive   TRUE: show the region only, never the place or countries
 *   show        FALSE: hidden from the pages
 *   image       photo URL (from realitysf.com/justice-outreach)
 *   link        a missionary's "Read their story" page, or a partner's website
 *
 * matchPartners() is pure: it scores each partner against one group's results.
 */

import * as sheetsApi from './sheets.js';

export const PARTNERS_TAB = 'Partners';
const HEADER = ['name', 'kind', 'org', 'side', 'heartbeats', 'countries', 'region', 'skills', 'place', 'description', 'sensitive', 'show', 'image', 'link'];

// Starting list: the church's supported missionaries and global partner
// organizations. J&O can change any of it in the Sheet.
const SEED = [
  // name, kind, org, side, heartbeats, countries, region, skills, place, description, sensitive, show, image, link
  // Global partner organizations
  ['Believe Academy', 'Partner', '', 'Global', 'Children & Education | Poverty & Economic Opportunity', 'Nicaragua', 'Latin America', 'Education', 'San Juan del Sur, Nicaragua',
    'Educational programs, food, clothing, job training, and activities so children in San Juan del Sur can reach their potential.', false, true, 'https://realitysf.com/wp-content/uploads/2024/05/BelieveAcademy.jpeg', 'https://www.believeacademy.co/'],
  ['Bread for the World', 'Partner', '', 'Global', 'Hunger & Clean Water | Justice & Human Rights', '', '', 'Law, Government & Policy', 'U.S. and worldwide',
    'Christian advocacy urging U.S. decision makers to pursue a world without hunger, and equipping people to advocate for policies that help end it.', false, true, 'https://realitysf.com/wp-content/uploads/2024/05/BreadfortheWorld-1024x682.png', 'https://bread.org/'],
  ['Caleb Mission', 'Partner', '', 'Global', 'Immigrants & Refugees | Justice & Human Rights | Mental Health', 'North Korea', 'East & Southeast Asia', 'Healthcare & Mental Health', 'North Korea',
    'Safely rescues North Korean defectors and advocates for their human rights, caring for their mental, physical, and spiritual restoration.', true, true, 'https://realitysf.com/wp-content/uploads/2024/05/CalebMission.jpg', 'https://www.calebmissionusa.org/'],
  ['The Chalmers Center', 'Partner', '', 'Global', 'Poverty & Economic Opportunity | Justice & Human Rights', '', '', 'Business & Finance | Church & Ministry', 'Worldwide',
    'Equips churches to walk alongside economically disadvantaged communities, overcoming the spiritual, emotional, and material bonds of poverty.', false, true, 'https://realitysf.com/wp-content/uploads/2019/07/Chalmers1-1024x683.jpg', 'https://www.chalmers.org/'],
  ['Children in Christ', 'Partner', '', 'Global', 'Children & Education | Youth & Young Adults | Evangelism', '', 'Africa', 'Education | Church & Ministry', '24 countries in Africa',
    'Equips children and youth across 24 African countries to know Christ deeply, through discipleship clubs, leadership development, and local churches.', false, true, 'https://realitysf.com/wp-content/uploads/2025/07/childreninchrist-1024x683.jpg', 'https://www.childrenic.org/'],
  ['Here For Kids International', 'Partner', '', 'Global', 'Children & Education | Foster Care & Family', '', '', 'Caregiving & Home', 'Worldwide',
    'Relief for at-risk children around the world, bringing hope and love to abandoned, abused, and neglected children.', false, true, 'https://realitysf.com/wp-content/uploads/2024/05/HereForKids1-1024x683.jpg', 'https://www.hereforkids.org/'],
  ['HOPE International', 'Partner', '', 'Global', 'Poverty & Economic Opportunity | Justice & Human Rights', '', '', 'Business & Finance', 'Worldwide',
    'Invests in the dreams of the poor through discipleship, training, savings, and small loans in dozens of countries.', false, true, 'https://realitysf.com/wp-content/uploads/2019/07/HOPEint2.jpg', 'https://www.hopeinternational.org/'],
  ['International Justice Mission', 'Partner', '', 'Global', 'Human Trafficking | Justice & Human Rights | Domestic Violence & Abuse', '', '', 'Law, Government & Policy', '19 countries worldwide',
    'Protects people in poverty from violence, combating trafficking, slavery, violence against women and children, and police abuse of power.', false, true, 'https://realitysf.com/wp-content/uploads/2025/07/IJM-2-1024x683.jpg', 'https://www.ijm.org/'],
  ['Nyanam', 'Partner', '', 'Global', 'Poverty & Economic Opportunity | Justice & Human Rights | Health Care', '', 'Africa', 'Healthcare & Mental Health', 'Africa',
    'Restorative justice preparing widows to lead community transformation through leadership, health, livelihoods, justice, and youth education.', false, true, 'https://realitysf.com/wp-content/uploads/2024/05/nyanam-1024x683.png', 'https://www.nyanam.org/'],
  // Supported missionaries
  ['Caleb & Alexius Alldrin', 'Missionary', 'Cru', 'Local', 'Youth & Young Adults | Evangelism', '', '', 'Student | Education', 'San Francisco',
    'With Cru in San Francisco since 2015, equipping college students with the skills, tools, and faith to impact their communities.', false, true, 'https://realitysf.com/wp-content/uploads/2019/06/Caleb_Alexius_Alldrin.jpg', 'https://realitysf.com/staff/caleb-alexius-cru/'],
  ['Gabby & Mateo Alzate', 'Missionary', 'Because Justice Matters', 'Local', 'Human Trafficking | Domestic Violence & Abuse | Poverty & Economic Opportunity', '', '', '', 'Tenderloin',
    'Urban missionaries serving women, girls, and families, primarily in the Tenderloin.', false, true, 'https://realitysf.com/wp-content/uploads/2019/06/gabby-mateo-alzate.jpg', 'https://realitysf.com/staff/gabby-mateo-alzate/'],
  ['Steve Binnquist', 'Missionary', 'YWAM San Francisco', 'Local', 'Homelessness & Housing | Evangelism', '', '', '', 'San Francisco',
    'With YWAM San Francisco since 2004, and now its Director.', false, true, 'https://realitysf.com/wp-content/uploads/2019/06/binnquist-family.jpg', 'https://realitysf.com/staff/steve-binnquist-ywam-san-francisco/'],
  ['Miljenko & Nethanja Bojčić', 'Missionary', 'Athletes in Action', 'Global', 'Youth & Young Adults | Evangelism', 'Croatia', 'Eastern Europe & Russia', '', 'Croatia and the Balkans',
    'Using sports to share the gospel, disciple athletes and coaches, and cultivate flourishing communities in Croatia and the Balkans.', false, true, 'https://realitysf.com/wp-content/uploads/2026/09/Obitelj_Bojcic_2.jpeg', 'https://realitysf.com/staff/miljenko-nethanja-bojcic-athletes-in-action/'],
  ['Brooke & Karen Butler', 'Missionary', 'Athletes in Action', 'Local', 'Youth & Young Adults', '', '', 'Student', 'UC Berkeley',
    'At UC Berkeley since 2014, ministering to college athletes and their potential to impact their teams and world for Christ.', false, true, 'https://realitysf.com/wp-content/uploads/2019/06/karen-brooke-butler-e1698952363124.jpeg', 'https://realitysf.com/staff/brooke-karen-butler-athletes-in-action/'],
  ['Lauren Butts', 'Missionary', 'Because Justice Matters', 'Local', 'Human Trafficking | Domestic Violence & Abuse', '', '', '', 'Tenderloin',
    'Directs EdenMade, with a prevention mentorship program for girls and a relationship-centered program for women in the adult entertainment industry.', false, true, 'https://realitysf.com/wp-content/uploads/2019/06/Lauren_Butts.jpg', 'https://realitysf.com/staff/lauren-butts-because-justice-matters/'],
  ['Susanna Ciaramitaro', 'Missionary', 'Compassion First', 'Global', 'Human Trafficking | Children & Education | Mental Health', '', 'East & Southeast Asia', 'Healthcare & Mental Health', 'Southeast Asia',
    'Serves with Compassion First, an aftercare and rehabilitation center for child survivors of sex trafficking.', false, true, 'https://realitysf.com/wp-content/uploads/2019/06/Susanna_ciaramitaro.jpeg', 'https://realitysf.com/staff/susanna-ciaramitaro/'],
  ['Delwyn & Arielle Griffith', 'Missionary', 'Ethnos360', 'Global', 'Evangelism', '', 'Africa', '', 'West Africa',
    'Serving in West Africa since 2012, helping people connect with God and each other.', false, true, 'https://realitysf.com/wp-content/uploads/2023/02/Griffith-family.jpg', 'https://realitysf.com/staff/delwyn-arielle-griffith-ethnos360/'],
  ['Sylvia Kamande', 'Missionary', 'Because Justice Matters', 'Local', 'Domestic Violence & Abuse | Human Trafficking', 'Kenya', '', '', 'Tenderloin',
    'Originally from Nairobi, helping break the cycle of fear, violence, and hopelessness many women and girls experience in San Francisco.', false, true, 'https://realitysf.com/wp-content/uploads/2019/06/sylvia-kamande-e1698952104711.jpeg', 'https://realitysf.com/staff/sylvia-kamande-because-justice-matters/'],
  ['Jeremy & Christa Kastle', 'Missionary', 'International Missionaries', 'Global', 'Evangelism', 'United Kingdom', 'Western Europe', '', 'Northern Ireland',
    'In global missions since 2014, now part of the gospel movement in Northern Ireland through voluntary and vocational work.', false, true, 'https://realitysf.com/wp-content/uploads/2025/10/KastleFamily20250415.jpg', 'https://realitysf.com/staff/jeremy-christa-kastle-action-international/'],
  ['Daniel Lai', 'Missionary', 'Young Life San Francisco', 'Local', 'Youth & Young Adults', '', '', 'Education', 'San Francisco',
    'On staff with Young Life, caring for youth in the city through accessible Christian programs for young people and their families.', false, true, 'https://realitysf.com/wp-content/uploads/2019/06/Daniel-Lai.jpg', 'https://realitysf.com/staff/daniel-lai-young-life-san-francisco/'],
  ['Jason & Justine Martinez', 'Missionary', 'Because Justice Matters', 'Local', 'Justice & Human Rights | Mental Health', '', '', 'Church & Ministry', 'San Francisco',
    'Mentors and spiritual directors, serving as missionaries in San Francisco for over twenty years.', false, true, 'https://realitysf.com/wp-content/uploads/2019/06/Martinez-LMs.jpeg', 'https://realitysf.com/staff/jason-justine-martinez-because-justice-matters/'],
  ['Udom Setthaya', 'Missionary', 'YWAM San Francisco', 'Local', 'Homelessness & Housing | Addiction Recovery', 'Thailand', '', '', 'Tenderloin',
    'Originally from Thailand, serves residents of the Tenderloin through the Restoration Initiatives Ministry.', false, true, 'https://realitysf.com/wp-content/uploads/2023/02/Udom-Setthaya-e1698951933631.jpeg', 'https://realitysf.com/staff/udom-setthaya-ywam-san-francisco/'],
  ['The "J" Family', 'Missionary', 'International Missionaries', 'Global', 'Evangelism', '', 'East & Southeast Asia', '', 'Southeast Asia',
    'Living and serving in Southeast Asia, making disciples of Jesus among the least-reached.', true, true, 'https://realitysf.com/wp-content/uploads/2025/05/wendell-shinn-ct3-bruKcSg-unsplash-copy-2.jpg', 'https://realitysf.com/staff/the-j-family-international-missionaries/'],
];

const list = v => String(v ?? '').split('|').map(s => s.trim()).filter(Boolean);
const bool = (v, fallback) => {
  const s = String(v ?? '').trim().toUpperCase();
  if (['TRUE', 'YES', 'Y', '1'].includes(s)) return true;
  if (['FALSE', 'NO', 'N', '0'].includes(s)) return false;
  return fallback;
};

/** Only http(s) links from the Sheet reach the page */
function safeUrl(v) {
  const s = String(v ?? '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

/** Sheet row object → partner; null if it has no name */
export function parsePartner(r) {
  const name = String(r.name ?? '').trim();
  if (!name) return null;
  const side = String(r.side ?? '').trim().toLowerCase();
  return {
    name,
    kind: /missionar/i.test(r.kind ?? '') ? 'Missionary' : 'Partner',
    org: String(r.org ?? '').trim(),
    description: String(r.description ?? '').trim(),
    local: side === 'local' || side === 'both',
    global: side !== 'local',
    heartbeats: list(r.heartbeats),
    countries: list(r.countries),
    region: String(r.region ?? '').trim(),
    skills: list(r.skills),
    place: String(r.place ?? '').trim(),
    sensitive: bool(r.sensitive, false),
    show: bool(r.show, true),
    image: safeUrl(r.image),
    link: safeUrl(r.link),
  };
}

/** What the pages may see: a sensitive partner shows its region, never its place */
export function publicPartner(p) {
  return {
    name: p.name,
    kind: p.kind,
    org: p.org,
    description: p.description,
    local: p.local,
    global: p.global,
    place: p.sensitive ? (p.region || 'Overseas') : (p.place || p.region || 'Worldwide'),
    heartbeats: p.heartbeats,
    image: p.image,
    link: p.link,
  };
}

export function createPartnerStore(sheetId, api = sheetsApi) {
  let partners = [];

  async function load() {
    const { header, rows } = await api.readOrCreateTab(sheetId, PARTNERS_TAB, HEADER);
    if (rows.length === 0) {
      const seed = SEED.map(r => r.map(v => (typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : v)));
      await api.appendRowsRaw(sheetId, PARTNERS_TAB, seed);
      partners = api.rowsToObjects(HEADER, seed).map(parsePartner).filter(Boolean);
      return;
    }
    partners = api.rowsToObjects(header, rows).map(parsePartner).filter(Boolean);
  }

  return {
    load,
    /** Partners the pages may show */
    visible: () => partners.filter(p => p.show),
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// How much each kind of overlap counts, per share of the group
const WEIGHT = { heart: 3, country: 2, region: 1, skill: 1 };
const HIGHLIGHTS = 3;

/**
 * Score partners against one group's results (a serialized ProcessedState).
 * Each score is a sum of (people in the group who share it / people who
 * shared) × weight, so it reads as "how much of the group this fits".
 *
 * @returns {Array<{partner, score: number, reasons: string[], fit: boolean}>}
 *   in the partners' original order; `fit` marks the top few, with at least
 *   one missionary and one partner when any of each match
 */
export function matchPartners(partners, state) {
  const n = state.totalPeople || 0;
  if (!n) return partners.map(partner => ({ partner, score: 0, reasons: [], fit: false }));

  const hearts = state.heartbeatCounts || {};
  const skills = state.vocationCounts || {};
  const countryPicks = state.countryPicks || {};
  const regionReach = state.regionReach || {}; // people who picked a region or a country in it
  const bay = state.sfBayCount || 0;            // people who named places in SF or the Bay Area

  const scored = partners.map(partner => {
    let score = 0;
    const reasons = [];
    for (const h of partner.heartbeats) {
      const c = hearts[h]?.count || 0;
      if (!c) continue;
      score += WEIGHT.heart * c / n;
      reasons.push({ c, text: `${people(c, 'care')} about ${h.toLowerCase()}` });
    }
    let namedCountry = false;
    if (!partner.sensitive) {
      for (const country of partner.countries) {
        const c = countryPicks[country] || 0;
        if (!c) continue;
        namedCountry = true;
        score += WEIGHT.country * c / n;
        reasons.push({ c, text: `${people(c, 'named')} ${country}` });
      }
    }
    const reach = partner.region ? regionReach[partner.region] || 0 : 0;
    if (reach && !namedCountry) {
      score += WEIGHT.region * reach / n;
      reasons.push({ c: reach, text: `${people(reach, 'feel')} connected to ${partner.region}` });
    }
    if (partner.local && bay) {
      score += WEIGHT.region * bay / n;
      reasons.push({ c: bay, text: `${people(bay, 'feel')} connected to SF and the Bay Area` });
    }
    for (const s of partner.skills) {
      const c = skills[s]?.count || 0;
      if (!c) continue;
      score += WEIGHT.skill * c / n;
      reasons.push({ c, text: `${people(c, 'bring')} ${s.toLowerCase()}` });
    }
    reasons.sort((a, b) => b.c - a.c);
    return { partner, score, reasons: reasons.map(r => r.text), fit: false };
  });

  // Highlights: the best missionary and the best partner, then the best of the rest
  const ranked = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  const picks = new Set(['Missionary', 'Partner'].map(kind => ranked.find(s => s.partner.kind === kind)).filter(Boolean));
  for (const s of ranked) {
    if (picks.size >= HIGHLIGHTS) break;
    picks.add(s);
  }
  for (const s of picks) s.fit = true;
  return scored;
}

/** "3 of you care", "1 of you cares" */
function people(c, verb) {
  if (c !== 1) return `${c} of you ${verb}`;
  return `1 of you ${verb.endsWith('ed') ? verb : `${verb}s`}`;
}
