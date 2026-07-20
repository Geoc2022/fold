# Fold

A website for activities (atm primarily at Cloudflare).

Try the tutorial at `/fold`

## Next Steps:

### Leaderboard

It would be pretty fun to see the top people for a particular activity. At the moment, I think it's fine (and quite a bit easier) to have this be stored in people's local storage. Though, in the future maybe this requires some server signing data or using some computation on the server (there must be some cool algo like "A Linear Time Majority Vote Algorithm" that can get a good estimate). Also, this would need to be approved by the user to track this and store on local machines.

### Filtering by Spaces (Location/Group)

We could have a breakdown by different places, so people don't see activities in places not relevant to them. We could represent spaces as a tiles which breakup into more tiles when you expand them or "file directories".

**Example Hierarchy** `All/US/TX/Austin/Cloudflare`

Here, even though Cloudflare has multiple locations, it makes more sense to split by location and then organization since users have priority on location then availability.

This filtering needs to be embedded in the URL, however the URL can't get too long. There are some ways to shorten it: coordinates, > 8 digits of info and unreadable; airport codes, biased; sparsity, where sections can have their own alias (ex. CF-AUS expands to the example above) - good but "hard" to implement.

#### Organization Sign In and Restricted Access

It would probably be nice to have some verification with the some of the spaces. Also, some spaces may need to be private though registration. There are already private activities, which are only accessible by links.

### Essential People

Some people are required for an activity (e.g., they have the frisbee or the board game). Currently, every user looks the same and can pretend to be other users. Which connects registration.

### Security/Registration

There are only 456,976 possible codes, which is not a lot. Maybe filtering by spaces can help with this, allowing people to request commonly used codes as long as it's unique to the space. This also makes it easy to iterate through them.

Users can create activities easily, which is great, but users can create activities easily.

More broadly, maybe registration is needed for the site despite how annoying it is on both the user/server side. Also, increases the friction of using the site which is kinda disappointing.

### Connection to External Services/Info

- calendar
    - Read: Poll when people are free - it would be nice to have a "convex hull" of when people are free ignoring small gaps between meetings
    - Write: Creating an event for posterity or visibility for others
- messaging (Google chat, Discord, etc.)
    - Adding messaging connections means you can have everything in one space
- location
    - Some of the original ideas were to use MPC to securely help people know whether the courts/parks were free/had people interested in running a game
- RSS?

### App Version

There's already support to set it up as a PWA. And it works perfectly fine on Android and probably not too bad on iOS, but it's a little difficult to install a PWA on iOS. I also don't know about how notification support works.

Regardless the website seems sufficient for now, and it is somewhat mobile accessible.

### Verification of Policies

One, notifications are technically hard (maybe we need to work on a scheduler) and this requires more testing. But, there are also interesting questions if you abstract that away.

The policy language makes it hard to write wrong policies, but the way the language is set up makes it easy to detect when someone writes an inconsistent policy (liveliness, etc.).

I think an interesting question is can we use the language to help us understand when we need to poll and if we need to poll (questions a notification scheduler cares about). I'm sure there's already research done into stuff like this. And, how can we use ideas from the literature to help our language better reflect that. Kinda like how Rust has developed interesting ideas / design choices when wrestling with ownership and lifetimes because how tricky memory is.
