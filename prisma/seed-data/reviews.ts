/**
 * Seed reviews (fictional guests, Nigerian names). Scores are
 * [overall, cleanliness, service, location, value]. `reply` is the hotel's
 * answer, `flag` marks a review reported for moderation.
 */
export interface ReviewSeed {
  guest: string;
  scores: [number, number, number, number, number];
  traveller: 'BUSINESS' | 'COUPLE' | 'FAMILY' | 'SOLO' | 'FRIENDS';
  title?: string;
  body: string;
  /** Days before today the guest checked out. */
  ago: number;
  nights: number;
  reply?: string;
  flag?: string;
}

export const REVIEWS: Record<string, ReviewSeed[]> = {
  'palmwine-house': [
    { guest: 'Chiamaka Okonkwo', scores: [5, 5, 5, 4, 5], traveller: 'COUPLE', title: 'Quiet corner of Lekki', body: 'We came for our anniversary and the team had the room set up with flowers before we arrived. The Deluxe King is spacious, the bed is excellent and the generator switch-over at night was so smooth we did not notice it. Breakfast pepper soup is worth waking up for.', ago: 3, nights: 2, reply: 'Thank you, Chiamaka. It was a pleasure hosting you both, and we will tell the kitchen the pepper soup has a fan. Come back for the next anniversary.' },
    { guest: 'Babatunde Adeyemi', scores: [4, 4, 5, 4, 4], traveller: 'BUSINESS', title: 'Reliable for work trips', body: 'Stable Wi-Fi, a proper desk and staff who remember how you take your tea. Traffic to Victoria Island in the morning is the only real problem, but that is Lekki, not the hotel. Invoice was ready for my company at check-out.', ago: 6, nights: 3 },
    { guest: 'Ngozi Eze', scores: [3, 3, 4, 4, 3], traveller: 'SOLO', title: 'Good staff, tired bathroom', body: 'Front desk was warm and quick. The Standard Queen bathroom needs attention: the shower pressure was weak and the grout is stained. For the price I expected better. Location and security are fine.', ago: 9, nights: 1, reply: 'Thank you for the honest feedback, Ngozi. Rooms 101 to 108 are getting new shower mixers this month and the grout is being redone. We hope to show you the difference.' },
    { guest: 'Ibrahim Musa', scores: [5, 5, 4, 5, 4], traveller: 'FAMILY', body: 'Stayed with my wife and two children. The Palm Suite fits everyone comfortably and the staff found us a cot without fuss. Close to the Lekki Conservation Centre, which the kids loved.', ago: 12, nights: 3 },
    { guest: 'Funke Akindele-Bello', scores: [4, 5, 4, 3, 4], traveller: 'FRIENDS', title: 'Clean and calm', body: 'Three of us came for a wedding in Ikate. Rooms were spotless every day. Getting a taxi at night took a while, so plan ahead, but the desk will call one for you.', ago: 15, nights: 2 },
    { guest: 'Emeka Nwosu', scores: [2, 3, 2, 4, 2], traveller: 'BUSINESS', title: 'Check-in took too long', body: 'I arrived at 3pm and waited almost forty minutes because the room was not ready, with no offer of a drink or a place to work. The room itself was fine once I got in. Management should sort out the handover between housekeeping and front desk.', ago: 18, nights: 1, reply: 'Emeka, you are right and we are sorry. That afternoon two departures ran late and we did not communicate well. We have changed how housekeeping reports clean rooms to the desk so this does not repeat.' },
    { guest: 'Aisha Bello', scores: [5, 5, 5, 4, 5], traveller: 'SOLO', body: 'Felt completely safe as a woman travelling alone. The night manager walked me to my room when I came back late from an event. Small touches like that matter. Will book again.', ago: 21, nights: 2 },
    { guest: 'Oluwaseun Ogunleye', scores: [4, 4, 4, 4, 4], traveller: 'COUPLE', body: 'Solid stay. Nothing spectacular, nothing wrong. Breakfast could have more variety, the room was quiet and the AC worked all night.', ago: 24, nights: 2 },
    { guest: 'Kelechi Ibekwe', scores: [5, 4, 5, 5, 4], traveller: 'BUSINESS', title: 'Best value in Lekki Phase 1', body: 'I have tried four hotels on this stretch and this one gets the basics right: water pressure, power, Wi-Fi, and a front desk that answers the phone. The online booking worked first time and the room was assigned before I landed.', ago: 27, nights: 4 },
    { guest: 'Temitope Balogun', scores: [3, 4, 3, 4, 3], traveller: 'FAMILY', body: 'Rooms are nice but the restaurant closes too early for families arriving late from the airport. We had to order food in. Staff were polite about it.', ago: 33, nights: 2 },
    { guest: 'Uchenna Obi', scores: [5, 5, 5, 5, 5], traveller: 'COUPLE', body: 'Everything was lovely. The staff even arranged a boat trip to Tarkwa Bay for us. Thank you to Ngozi at the front desk.', ago: 40, nights: 3, reply: 'Thank you Uchenna, Ngozi was delighted to read this. See you again soon.' },
    { guest: 'Halima Abubakar', scores: [4, 4, 4, 3, 4], traveller: 'BUSINESS', body: 'Comfortable and well run. The street can be noisy in the evening because of the event centre nearby, so ask for a room at the back.', ago: 46, nights: 2 },
  ],
  'ikoyi-lantern': [
    { guest: 'Adaeze Okafor', scores: [5, 5, 5, 5, 4], traveller: 'BUSINESS', title: 'Understated and excellent', body: 'The rooms feel like a private flat in old Ikoyi. Linen, lighting and the quiet were all first class. Expensive, but you get what you pay for, and the airport transfer was on time at 5am.', ago: 55, nights: 2, reply: 'Thank you, Ms Okafor. We look forward to your next visit to Ikoyi.' },
    { guest: 'Olumide Coker', scores: [5, 5, 5, 5, 5], traveller: 'COUPLE', body: 'Faultless weekend. The garden terrace at dusk with the lanterns lit is something else. Staff anticipate what you need without hovering.', ago: 20, nights: 2 },
    { guest: 'Ifeoma Chukwu', scores: [4, 5, 4, 5, 3], traveller: 'SOLO', body: 'Beautiful property and a perfect location for Falomo and the Ikoyi galleries. At this price I expected the minibar and laundry to be less expensive. Still a very good stay.', ago: 38, nights: 3 },
    { guest: 'Yusuf Danjuma', scores: [5, 5, 5, 4, 4], traveller: 'BUSINESS', body: 'Meeting room was well equipped and the kitchen handled a working lunch for eight at short notice. My clients were impressed.', ago: 61, nights: 1 },
    { guest: 'Bisola Martins', scores: [3, 4, 3, 5, 2], traveller: 'FRIENDS', title: 'Lovely but rigid', body: 'We asked for a late check-out of one hour and were told it would cost half a night. The hotel was not full. It left a bad taste after an otherwise lovely stay.', ago: 74, nights: 2, reply: 'Thank you for telling us, Bisola. Our late check-out policy has since changed: one free hour whenever the room is not needed. We would love to welcome you back.' },
    { guest: 'Chinedu Okeke', scores: [5, 5, 5, 5, 4], traveller: 'COUPLE', body: 'Took my wife for her fortieth. The team sent a cake to the room and remembered her name at breakfast. Truly special.', ago: 90, nights: 2 },
    { guest: 'Ruth Akpan', scores: [4, 4, 5, 5, 4], traveller: 'BUSINESS', body: 'Consistently good. The only thing I would change is the breakfast start time; 6:30 is late for early flights.', ago: 105, nights: 3 },
    { guest: 'Segun Oyelaran', scores: [5, 5, 4, 5, 5], traveller: 'SOLO', body: 'Worth every naira. Quiet enough to sleep past the Lagos noise, which is rare.', ago: 122, nights: 1 },
  ],
  'eko-tides': [
    { guest: 'Zainab Lawal', scores: [4, 4, 4, 5, 4], traveller: 'FRIENDS', title: 'Great for a girls weekend', body: 'Pool and rooftop view over the lagoon made the weekend. Rooms are compact but clean. Music from the rooftop bar reaches the upper floors until about midnight.', ago: 14, nights: 2 },
    { guest: 'Tobi Adeleke', scores: [3, 3, 3, 5, 3], traveller: 'COUPLE', body: 'Fantastic location on Victoria Island but the room smelt of damp and the AC dripped. We were moved after we complained, which helped.', ago: 29, nights: 2, reply: 'Tobi, we apologise. The AC unit in that room has been replaced and the carpet removed. Thank you for your patience while we moved you.' },
    { guest: 'Grace Etim', scores: [5, 4, 5, 5, 4], traveller: 'BUSINESS', body: 'Walking distance to my office on Adeola Odeku. Fast check-in, friendly staff and good coffee in the lobby.', ago: 41, nights: 3 },
    { guest: 'Daniel Ekwueme', scores: [4, 4, 4, 5, 4], traveller: 'SOLO', body: 'Good base for a first trip to Lagos. The front desk gave clear advice on getting around and which areas to visit.', ago: 57, nights: 4 },
    { guest: 'Amina Garba', scores: [2, 2, 3, 5, 2], traveller: 'FAMILY', title: 'Not suitable for children', body: 'The pool has no shallow area and no lifeguard, and the rooms are too small for a family of four even with the extra bed. Staff were kind but the hotel is clearly set up for young adults.', ago: 66, nights: 2 },
    { guest: 'Femi Alabi', scores: [4, 4, 4, 5, 4], traveller: 'FRIENDS', body: 'Had a good time for a friend’s birthday. Rooftop staff were efficient even when it got busy.', ago: 80, nights: 1 },
    { guest: 'Stella Nnaji', scores: [5, 5, 4, 5, 4], traveller: 'COUPLE', body: 'Lovely sunset from the lagoon-view room. We would definitely come back.', ago: 98, nights: 2, flag: 'Reported by the hotel: the guest mentioned a staff member by full name in an earlier version.' },
  ],
  'maitama-court': [
    { guest: 'Hauwa Sani', scores: [5, 5, 5, 5, 4], traveller: 'BUSINESS', title: 'Abuja at its best', body: 'Quiet, secure and five minutes from the ministries. Conference facilities are excellent and the staff handled our delegation of twelve with no hiccups.', ago: 17, nights: 3, reply: 'Thank you, Hauwa. Hosting your delegation was a pleasure.' },
    { guest: 'Victor Okoro', scores: [4, 5, 4, 5, 3], traveller: 'BUSINESS', body: 'Spotless rooms and a serious gym. Room service prices are steep, even for Maitama.', ago: 34, nights: 2 },
    { guest: 'Maryam Idris', scores: [5, 5, 5, 4, 5], traveller: 'FAMILY', body: 'The family suite was perfect for us, with two bathrooms. The kids loved the pool and the staff were patient with them.', ago: 50, nights: 4 },
    { guest: 'Joseph Adamu', scores: [3, 4, 3, 4, 3], traveller: 'SOLO', body: 'Good hotel but the Wi-Fi dropped several times a day, which made remote work difficult. The desk reset the router each time but it kept happening.', ago: 71, nights: 5, reply: 'Joseph, thank you. We have since upgraded our network and added a second provider as a backup.' },
    { guest: 'Nkechi Umeh', scores: [5, 5, 5, 5, 5], traveller: 'COUPLE', body: 'Calm, elegant and genuinely warm service. The breakfast spread has both Nigerian and continental options done well.', ago: 88, nights: 2 },
    { guest: 'Aliyu Mohammed', scores: [4, 4, 5, 5, 4], traveller: 'BUSINESS', body: 'Always my choice in Abuja. Consistent every time.', ago: 110, nights: 2 },
    { guest: 'Patience Ogbu', scores: [4, 4, 4, 4, 4], traveller: 'FRIENDS', body: 'Came for a conference with colleagues. Comfortable rooms and a lovely lounge to catch up in the evenings.', ago: 130, nights: 3 },
  ],
  'garden-city-lodge': [
    { guest: 'Tamunotonye Jack', scores: [4, 4, 4, 4, 4], traveller: 'BUSINESS', body: 'Well placed in GRA for oil and gas meetings. The generator is reliable and the rooms are quiet. Breakfast is basic.', ago: 11, nights: 3 },
    { guest: 'Boma Harry', scores: [5, 5, 5, 4, 5], traveller: 'FAMILY', title: 'Felt like home', body: 'We stayed during a family event and the lodge staff treated my mother like royalty. Rooms are simple but very clean.', ago: 32, nights: 2, reply: 'Thank you Boma. Please greet your mother for us.' },
    { guest: 'Ebiere Dappa', scores: [3, 3, 4, 4, 4], traveller: 'SOLO', body: 'Decent value. My room needed repainting and the TV remote did not work, but the staff were helpful and the price is fair for Port Harcourt.', ago: 48, nights: 2 },
    { guest: 'Ikechukwu Nwachukwu', scores: [4, 4, 5, 4, 4], traveller: 'BUSINESS', body: 'The security team is professional, which matters in PH. Would stay again for work.', ago: 63, nights: 4 },
    { guest: 'Ibinabo Green', scores: [2, 2, 3, 4, 2], traveller: 'COUPLE', title: 'Needs a refresh', body: 'Our room had a musty smell and the bedsheets had small holes. For a Growth-level price I would expect better upkeep. Staff apologised but could not move us because the lodge was full.', ago: 79, nights: 2, reply: 'We are sorry, Ibinabo. We have replaced the linen in all rooms and started a room-by-room refurbishment. Thank you for your honesty.' },
    { guest: 'Soye Tariah', scores: [4, 4, 4, 5, 4], traveller: 'FRIENDS', body: 'Good for a weekend with friends; close to the restaurants on Aba Road.', ago: 95, nights: 2 },
  ],
  'bodija-heights': [
    { guest: 'Adebola Ajayi', scores: [4, 4, 4, 4, 5], traveller: 'FAMILY', body: 'Great value in Bodija. Rooms are simple but clean and the staff pointed us to the best amala in town.', ago: 23, nights: 2 },
    { guest: 'Kunle Afolabi', scores: [4, 4, 4, 4, 4], traveller: 'BUSINESS', body: 'Close to UI where I had meetings. Good Wi-Fi and a quiet compound.', ago: 45, nights: 3 },
    { guest: 'Folasade Oyewole', scores: [3, 3, 3, 4, 4], traveller: 'SOLO', body: 'Fair for the price. Hot water took a long time to come through in the morning.', ago: 67, nights: 1, reply: 'Thank you, Folasade. We have added a second water heater on your floor.' },
    { guest: 'Olalekan Adewale', scores: [5, 4, 5, 4, 5], traveller: 'FRIENDS', body: 'We came for a reunion and the manager helped us book the hall next door. Friendly, helpful people.', ago: 84, nights: 2 },
    { guest: 'Morenike Salako', scores: [4, 4, 4, 4, 4], traveller: 'COUPLE', body: 'Peaceful weekend away from Lagos. Would come back.', ago: 101, nights: 2 },
    { guest: 'Tunde Olaniyan', scores: [2, 3, 2, 4, 3], traveller: 'BUSINESS', title: 'Power cuts at night', body: 'The generator was switched off between 1am and 5am to save diesel and the room became unbearably hot. Nobody told us in advance. Everything else was fine but sleep matters most in a hotel.', ago: 36, nights: 2, reply: 'Tunde, thank you and we apologise. The generator now runs through the night, and the inverter covers switch-overs.' },
  ],
  'coal-city-retreat': [
    { guest: 'Chidiebere Onu', scores: [5, 5, 5, 4, 5], traveller: 'FAMILY', title: 'Best in Enugu for families', body: 'Big rooms, good security and a playground for the children. The kitchen made proper ofe onugbu when we asked. The kids did not want to leave.', ago: 16, nights: 3, reply: 'Thank you, Chidiebere. The kitchen team was proud to cook for you.' },
    { guest: 'Nneka Eze', scores: [4, 4, 4, 5, 4], traveller: 'BUSINESS', body: 'Independence Layout is quiet and central. Room was comfortable and the staff are courteous.', ago: 37, nights: 2 },
    { guest: 'Obinna Agu', scores: [3, 4, 2, 4, 3], traveller: 'SOLO', body: 'Nice rooms but slow service at the restaurant; food took over an hour one evening. The manager gave a discount, which I appreciated.', ago: 58, nights: 2 },
    { guest: 'Ogechi Nwankwo', scores: [5, 5, 5, 5, 4], traveller: 'COUPLE', body: 'Romantic and calm. The garden at night is beautiful. Highly recommended for a getaway.', ago: 76, nights: 2, flag: 'Automatic check: the text may contain a phone number or email address' },
    { guest: 'Kenechukwu Ude', scores: [4, 4, 4, 4, 4], traveller: 'BUSINESS', body: 'Good for work: reliable power and a decent desk. I will stay here on my next trip to Enugu.', ago: 92, nights: 3 },
    { guest: 'Amarachi Okoye', scores: [4, 5, 4, 4, 4], traveller: 'FRIENDS', body: 'Came for a friend’s wedding at the cathedral. Easy to get to and the rooms were very clean.', ago: 118, nights: 2 },
  ],
  'marina-creek': [
    { guest: 'Bassey Edet', scores: [4, 4, 4, 5, 4], traveller: 'COUPLE', body: 'Lovely creek views and a peaceful atmosphere. Calabar at its most relaxing.', ago: 26, nights: 3 },
    { guest: 'Eno Okon', scores: [3, 3, 4, 4, 3], traveller: 'FAMILY', body: 'Friendly staff and good food, but the rooms need maintenance: a broken wardrobe door and a loose tap.', ago: 52, nights: 2, reply: 'Thank you, Eno. Both have been fixed and we are reviewing all rooms.' },
    { guest: 'Imaobong Udoh', scores: [4, 4, 4, 5, 4], traveller: 'SOLO', body: 'Came for the carnival. Great location and the staff helped with transport to the parade route.', ago: 83, nights: 4 },
    { guest: 'Asuquo Effiong', scores: [5, 4, 5, 5, 5], traveller: 'BUSINESS', body: 'Warm Calabar hospitality. Good value and I slept well.', ago: 120, nights: 2 },
  ],
  'wuse-garden-suites': [
    { guest: 'Rukayat Olawale', scores: [4, 4, 4, 5, 4], traveller: 'BUSINESS', body: 'Walking distance to Wuse II shops and restaurants. Rooms are compact but modern.', ago: 19, nights: 2 },
    { guest: 'Musa Abdullahi', scores: [3, 3, 3, 5, 4], traveller: 'SOLO', body: 'Great location, average rooms. The AC was noisy.', ago: 44, nights: 1 },
    { guest: 'Grace Johnson', scores: [4, 4, 5, 4, 4], traveller: 'FRIENDS', body: 'Staff were very welcoming and helped us plan a day trip to Zuma Rock.', ago: 70, nights: 2 },
    { guest: 'Chukwuma Ani', scores: [4, 4, 4, 4, 4], traveller: 'COUPLE', body: 'Pleasant and good value for Abuja. We would stay again.', ago: 99, nights: 2 },
  ],
};
