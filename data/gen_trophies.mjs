// Rebuilds data/trophies.json from the trophy table below.
//
// I typed this table in this session from the house kit's practice cases
// (input/p00.in, the trophy list the bounty ships) and cross-checked the
// count against the public lists: 55 trophies, 1 platinum, 2 gold, 6 silver,
// 46 bronze, 28 hidden. Each row is [id, name, description, tier, points,
// secret]. Run it with `node data/gen_trophies.mjs` from the repo root; it
// writes data/trophies.json as one compact line and prints its sha256, so a
// later run can prove the file still matches this table byte for byte.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rows = [
  [1, 'Vice Got a Price!', "Congratulations! You're a Leonida Legend.", 'platinum', 300, false],
  [2, 'Just Like Paradise', 'Complete Gone Fishing.', 'bronze', 15, true],
  [3, 'Paradise Lost', 'Complete Chapter 1.', 'bronze', 15, true],
  [4, 'T**s Ass Drug Money', 'Complete Chapter 2.', 'bronze', 15, true],
  [5, 'Vice City, Baby!', 'Complete Chapter 3.', 'bronze', 15, true],
  [6, 'Top Of The World, Ma', 'Complete Chapter 4.', 'bronze', 15, true],
  [7, 'You Gotta Know When to Get Off', 'Complete the final mission.', 'gold', 90, true],
  [8, 'Trust', 'Complete Breakfast Run.', 'bronze', 15, true],
  [9, 'Break the Bank', 'Complete The Cartel Heist.', 'bronze', 15, true],
  [10, 'Family Matters', "Complete Child's Play.", 'bronze', 15, true],
  [11, 'DWNFALL', 'Complete Headliners.', 'bronze', 15, true],
  [12, 'Hi-Jacked', 'Complete VCIA Takedown.', 'bronze', 15, true],
  [13, 'Snow Storm', 'Complete Operation Savage Glory.', 'bronze', 15, true],
  [14, 'A Long Road', 'Attain 100% Completion.', 'gold', 90, false],
  [15, 'Cunning Stunts', 'Complete 250 Stunts.', 'silver', 30, false],
  [16, 'Master of None', 'Try each type of activity once.', 'bronze', 15, false],
  [17, 'The Shootist', 'Earn a gold medal in all Shooting Range challenges.', 'silver', 30, false],
  [18, 'Top Fun', 'Win a Top Fun Drone Race at every location.', 'bronze', 15, false],
  [19, 'Earn Cash, Not Kudos', 'Win 20 different races.', 'bronze', 15, false],
  [20, 'Baited My Tackle', 'Beat Cal in a fishing challenge.', 'bronze', 15, false],
  [21, 'Stick Fiddler', 'Complete an arcade game.', 'bronze', 15, false],
  [22, 'Road to Rehabilitation', 'Complete the final mission for Andy.', 'bronze', 15, true],
  [23, 'This Was No Boat Accident', 'Complete the final mission for Kenton.', 'bronze', 15, true],
  [24, 'The Lone Rider', 'Complete the final mission for Billy.', 'bronze', 15, true],
  [25, 'Strangers & Freaks', 'Complete 8 mission strands for strangers across the state of Leonida.', 'silver', 30, false],
  [26, 'Supply & Demand', 'Complete the final mission for Randy.', 'bronze', 15, true],
  [27, 'Spin On This!', 'Complete the final mission for Tyrone.', 'bronze', 15, true],
  [28, 'Positive Mental Attitude', 'Meditate at every spot across Leonida.', 'bronze', 15, false],
  [29, 'Fair Game', 'Hunt a unique animal for Bret.', 'bronze', 15, true],
  [30, "Don't Touch My Deck", 'Complete 3 Collectible Card sets.', 'silver', 30, false],
  [31, 'You WAiNKer!', 'WAiNK It at 100 locations.', 'silver', 30, false],
  [32, 'One Last Thing', 'Complete 50 Challenges.', 'bronze', 15, false],
  [33, 'Hot Together', 'Lose a 4 star Wanted Level with your partner and escape the heat.', 'bronze', 15, false],
  [34, 'Retail Therapy', 'Rob 3 shops back-to-back with your partner without losing your Wanted Level.', 'bronze', 15, false],
  [35, 'Whip It Good', 'Discover 100 vehicles.', 'bronze', 15, false],
  [36, 'Gunslinger', 'Take down 5 enemies in a single use of Combat Focus.', 'bronze', 15, false],
  [37, 'Catch Me If You Can', 'Make an unscheduled departure at VCIA.', 'bronze', 15, true],
  [38, 'Challenging Tank', 'Kinda hot in these Rhinos.', 'bronze', 15, true],
  [39, 'Sneakthief', 'Rob a jewelry store without being detected.', 'bronze', 15, false],
  [40, 'Maximum Withdrawal', 'Rob 5 Bank Vaults and escape.', 'silver', 30, false],
  [41, 'A Classic Blitz Play', 'Rob an Armored Truck and escape.', 'bronze', 15, false],
  [42, 'The Goodtime State', 'Explore all of Leonida.', 'bronze', 15, false],
  [43, 'Pest Control', 'Rob an Illegal Operation belonging to each gang.', 'bronze', 15, false],
  [44, 'In The Beginning…', 'Enjoy a cocktail with a view on Ocean Beach.', 'bronze', 15, true],
  [45, 'Capital Offense', 'Smash your way out of a vehicle showroom in classic style.', 'bronze', 15, true],
  [46, 'Let’s Go Bowling', "Follow-through at the Kolt & Associates' bowling alley.", 'bronze', 15, true],
  [47, 'Personal Best', 'A partnership with mass appeal.', 'bronze', 15, true],
  [48, 'Actions Speak Louder', 'Choices made (for better or worse).', 'bronze', 15, true],
  [49, 'Bad Luck, I Guess', "Second time's the charm.", 'bronze', 15, true],
  [50, 'The Truth Is Out There', 'What the hell just happened?', 'bronze', 15, true],
  [51, 'Ten Pin', "Bowl 'em over with a melee drive-by.", 'bronze', 15, true],
  [52, 'Dime on the Dollar', 'Earn $250,000 laundering Marked Bills through your contacts.', 'bronze', 15, false],
  [53, 'Treat Yo Self', 'Spend $100,000 across all shops.', 'bronze', 15, false],
  [54, 'Little Boxes', 'Purchase all garage properties.', 'bronze', 15, false],
  [55, 'On the Spot', 'Register 10 vehicles to the Scooter Bros app.', 'bronze', 15, false],
];

const out = rows.map(([id, name, description, tier, points, secret]) => ({
  description,
  id,
  name,
  points,
  secret,
  tier,
}));

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'data', 'trophies.json');
const text = JSON.stringify(out);
writeFileSync(target, text);
const sha = createHash('sha256').update(text).digest('hex');
console.log(`wrote ${target}: ${out.length} trophies, ${text.length} bytes, sha256 ${sha}`);
