# Marketing Strategy & Copy - Euno Discord Bot
Date: 2026-01-03

## Executive Summary

This document outlines the marketing strategy, copy, and page flow for Euno, a community moderation and management bot for Discord. The strategy emphasizes low-cost, sustainable marketing that converts three distinct audience segments through targeted landing pages into a seamless installation flow.

## Target Audience Segments

### 1. Corporate Community Managers
**Profile**: Professional community managers at tech companies, B2B SaaS firms, or enterprises running Discord communities for customer support, developer relations, or product communities.

**Pain Points**:
- Need to justify ROI and demonstrate community health metrics
- Require audit trails and compliance-friendly moderation
- Want to reduce moderation workload without sacrificing quality
- Need professional ticketing and escalation workflows

**Key Motivations**: Efficiency, professionalism, metrics/reporting, scalability

### 2. Enthusiast Community Managers
**Profile**: Passionate moderators of hobby communities, gaming guilds, creator communities, or fan servers. May be unpaid volunteers managing large communities.

**Pain Points**:
- Overwhelmed by moderation volume with limited mod team
- Dealing with spam and raid attacks
- Need democratic decision-making for controversial cases
- Want to maintain community culture while growing

**Key Motivations**: Reducing burnout, fair moderation, community safety, ease of use

### 3. Concerned Citizens
**Profile**: Server owners or admins who recently experienced a moderation crisis (spam attack, harassment incident, member safety issue) and need immediate solutions.

**Pain Points**:
- Just experienced a specific incident (spam wave, toxic user)
- Worried about community safety and member retention
- Need quick deployment and immediate protection
- May have limited technical knowledge

**Key Motivations**: Immediate protection, peace of mind, preventing future incidents, simplicity

## Core Features Summary

### 1. **Private Ticketing System**
- One-click button setup for member-to-moderator private threads
- Configurable triggers and mod role assignments
- Closure tracking with optional feedback collection
- Use cases: Reporting harassment, asking moderation questions, appeals

### 2. **Track & Report System**
- Anonymous reporting via right-click context menu
- Staff tracking (non-anonymous) for pattern documentation
- Centralized reporting threads with full context
- Automatic cross-referencing of repeat offenders

### 3. **Democratic Escalation & Voting**
- Multi-level escalation system (simple → majority voting)
- Configurable quorum and voting strategies
- Actions: delete, timeout, restrict, kick, ban
- Built-in consensus building for controversial decisions
- Expedite option for urgent cases

### 4. **Spam Honeypot**
- Trap channel that auto-kicks anyone posting
- Catches bots that auto-post to every channel
- Configurable warning message for legitimate users
- Silent protection that doesn't disrupt community

### 5. **AutoMod Spam Defense**
- Real-time content scanning with keyword detection
- Automatic message deletion for detected spam
- Progressive enforcement (warnings → auto-kick)
- Staff exemption to prevent false positives

### 6. **Reactji Channel Forwarding**
- Forward messages to curated channels based on emoji reactions
- Configurable thresholds (e.g., 5 ⭐ reactions = featured)
- Use cases: Highlight reels, best-of channels, content curation
- Community-driven content promotion

## Marketing Page Flow

### Landing Page Architecture

```
Homepage (/)
├─ Corporate Landing (/for/teams)
├─ Enthusiast Landing (/for/communities)
└─ Incident Response (/for/protection)
    ↓
  Feature Pages (optional deep-dive)
    ├─ /features/ticketing
    ├─ /features/moderation
    ├─ /features/spam-protection
    └─ /features/analytics
    ↓
  Pricing (/pricing)
    ↓
  Add to Discord (OAuth flow)
    ↓
  Onboarding (/onboard/{guildId})
    └─ Installation Complete
```

## Landing Page Copy

---

## Homepage: Main Landing Page (`/`)

### Hero Section

**Headline**: Transform Your Discord Community with Professional Moderation

**Subheadline**: Euno gives your mod team powerful tools to keep your community safe, engaged, and growing—without the burnout.

**CTA Buttons**:
- Primary: "Add to Discord Server" → OAuth flow
- Secondary: "See How It Works" → Scroll to features

**Hero Visual**: Animated emoji background (existing design maintained)

### Social Proof Section

**Stats Bar** (if available from analytics):
- "X servers protected"
- "X million messages moderated"
- "X average response time reduction"

### Three-Column Audience Teaser

**For Teams** | **For Communities** | **Under Attack?**
Professional moderation for companies | Tools for volunteer mod teams | Stop spam & raids now
[Learn More →](/for/teams) | [Learn More →](/for/communities) | [Get Protected →](/for/protection)

### Features Overview (Brief)

**Stop Problems Before They Start**
- Automated spam protection catches bad actors instantly
- Honeypot channels trap bots automatically
- Keyword detection with customizable filters

**Resolve Issues Fairly**
- Democratic voting system for controversial cases
- Full audit trail for every moderation action
- Anonymous reporting for community members

**Scale Your Mod Team**
- Private ticketing system for member support
- Curate great content with reaction-based forwarding
- Detailed analytics on community health

### Footer CTA

**Ready to protect your community?**
[Add Euno to Discord →]

---

## Corporate Landing Page (`/for/teams`)

### Hero

**Headline**: Enterprise-Grade Community Moderation for Discord

**Subheadline**: Give your developer relations, customer success, and community teams the professional tools they need to scale community operations safely and efficiently.

**CTA**: "Start Free Trial" | "Schedule Demo"

### Problem/Solution Section

**The Challenge**
Your Discord community is a critical touchpoint for customers and developers. But as it grows, so do moderation demands, compliance concerns, and the risk of reputation damage from bad actors.

**The Euno Advantage**
Built for professional community operations with the audit trails, workflows, and analytics that enterprise teams require.

### Feature Benefits (Corporate Focus)

**🎫 Professional Ticketing System**
- Private, threaded conversations between members and mods
- Configurable escalation paths
- Closure tracking with satisfaction ratings
- **Business Value**: Reduce support burden, improve CSAT scores

**📊 Comprehensive Analytics & Reporting**
- Activity metrics by channel, user, and time period
- Moderation action dashboards
- Exportable reports for stakeholder review
- **Business Value**: Demonstrate community ROI, identify trends

**⚖️ Structured Escalation Workflows**
- Democratic decision-making with voting systems
- Configurable quorum and approval thresholds
- Complete audit trail for compliance
- **Business Value**: Consistent enforcement, reduced liability

**🛡️ Multi-Layer Spam Protection**
- Automated keyword filtering
- Honeypot channels for bot detection
- Progressive enforcement (warn → remove → ban)
- **Business Value**: Protect brand reputation 24/7

**👥 Track & Report System**
- Anonymous member reporting
- Staff tracking for pattern documentation
- Cross-referenced reporting threads
- **Business Value**: Early warning system for community health issues

**⭐ Content Curation (Reactji Forwarding)**
- Highlight community contributions automatically
- Surface valuable discussions for broader audience
- Community-driven promotion
- **Business Value**: Increase engagement, showcase ROI

### Pricing Teaser

**Free tier available** for teams getting started
**Professional tier** includes priority support and advanced features
[View Full Pricing →]

### Trust Elements

**Security & Compliance**
- Data stored in your Discord server
- No message content stored externally
- Open source (AGPL-3.0 license)
- Self-hostable for enterprise needs

### CTA Section

**Ready to scale your community operations?**
Start with our free tier. Upgrade when you need advanced features.
[Add to Discord →] [View Pricing →]

---

## Enthusiast Landing Page (`/for/communities`)

### Hero

**Headline**: Moderation Tools That Don't Burn You Out

**Subheadline**: You love your community, not the endless moderation grind. Euno handles the spam and gives your mod team the tools to make fair decisions together—without the drama.

**CTA**: "Add to Your Server—It's Free"

### Problem/Empathy Section

**Sound Familiar?**
- Your mod team is exhausted from spam waves and edge cases
- Controversial moderation decisions cause drama and resignations
- You're losing good mods to burnout
- Manual tracking of problem users is overwhelming
- You need tools but can't afford enterprise solutions

**You Need Euno**
Built by moderators, for moderators. Automate the grunt work, democratize tough decisions, and get back to building your community.

### Feature Benefits (Enthusiast Focus)

**🤖 Stop Spam Automatically**
Wake up to a clean server, not a disaster. Euno's spam detection works 24/7 so you don't have to.
- Auto-delete spam messages
- Honeypot channels catch bots
- Auto-kick repeat offenders

**⚖️ Let Your Team Decide Together**
No more "bad cop" moderator taking all the heat. Vote on tough cases as a team.
- Democratic voting for bans, kicks, timeouts
- Configurable quorum (require 3 votes, 5 votes, etc.)
- Escalate to majority vote for controversial cases
- Full transparency in mod channels

**📢 Anonymous Reporting for Members**
Let your community flag problems without fear of retaliation.
- Right-click any message → Report
- Creates private mod thread with full context
- Automatic cross-referencing of repeat issues
- Staff can "Track" users for pattern building

**🎫 Private Tickets Without the Bot Spam**
Give members a direct line to mods without clogging public channels.
- One button, private thread, problem solved
- Configurable for different use cases (appeals, questions, reports)
- Simple closure tracking

**⭐ Celebrate Great Content**
Let your community curate itself. Popular messages automatically forwarded to highlight channels.
- Configure any emoji trigger (⭐, 🔥, 💯)
- Set thresholds (5 reactions, 10 reactions, etc.)
- Perfect for "best-of" or "hall-of-fame" channels

### Pricing for Communities

**Free Forever Tier**
All core features. No credit card required.

**Optional Premium** (coming soon)
Advanced analytics and priority support for growing communities.

### Testimonial Placeholder

> "We went from spending 4 hours a day on spam cleanup to maybe 10 minutes. Euno handles everything while we sleep."
> — *Server owner, 15K member gaming community*

### CTA Section

**Join thousands of communities already using Euno**
[Add to Discord—Free Forever →]

---

## Incident Response Landing Page (`/for/protection`)

### Hero (Urgent tone)

**Headline**: Stop the Attack. Protect Your Community. Right Now.

**Subheadline**: Spam bots? Raid? Harassment? Deploy Euno in 60 seconds and get automated protection immediately.

**CTA**: "PROTECT MY SERVER NOW" (large, urgent button)

### Immediate Solutions

**If You're Being Spammed or Raided:**

✅ **Deploy in 60 seconds**: Click button, add bot, it starts working immediately
✅ **Automatic spam deletion**: Bad messages removed instantly
✅ **Auto-kick repeat offenders**: Bots gone after 3 strikes
✅ **Honeypot trap channels**: Catch bots that auto-post everywhere

**The Attack Stops. Your Community Stays Safe.**

### How It Works (Simple 3-Step)

**1. Add to Discord** (30 seconds)
Click "Add to Discord", select your server, authorize permissions.

**2. Quick Setup** (30 seconds)
Set your mod role and mod log channel. Done.

**3. Protected** (Immediate)
Spam detection is active. Honeypot suggestion provided. You're safe.

### Additional Protection Features

**After the immediate crisis:**
- Set up private ticketing for members to report issues
- Enable anonymous reporting with right-click menu
- Configure democratic escalation for edge cases
- Review analytics to understand what happened

### Urgency Reinforcement

**Every minute counts during an attack.**
The faster you deploy, the less damage is done.

[PROTECT MY SERVER NOW →]

### Reassurance Section

**Free to use. No credit card needed.**
Full spam protection on the free tier.

**Open source and transparent.**
See exactly what the bot does: [GitHub link]

**Used by thousands of servers.**
Battle-tested against every type of spam and raid.

---

## Installation & Onboarding Flow

### Step 1: Add to Discord (OAuth)

**Page**: Discord OAuth redirect

**Experience**:
- User clicks "Add to Discord" from any landing page
- Redirected to Discord's OAuth consent page
- Required permissions clearly explained:
  - Read Messages (to detect spam)
  - Manage Messages (to delete spam)
  - Kick Members (for auto-kick)
  - Manage Threads (for ticketing)
  - View Channels (to find honeypot)

**After Authorization**:
- Redirected to `/onboard/{guildId}` on Euno web app

### Step 2: Web-Based Onboarding (`/onboard/{guildId}`)

**Page Title**: "Set up Euno for [Server Name]"

**Required Configuration**:
1. **Moderator Role**: Dropdown of server roles
   - *What this does*: Members with this role can use moderation commands
   
2. **Mod Log Channel**: Dropdown of text channels
   - *What this does*: Where reports and escalation votes will be posted

3. **Restricted Role** (Optional): Dropdown of server roles
   - *What this does*: Role to assign when restricting a user (requires /restrict command)

**CTA**: "Complete Setup" button

**After Submission**:
- Settings saved to database
- Bot becomes fully operational
- Redirect to post-onboarding page

### Step 3: Post-Onboarding Success Page

**Headline**: "✅ Euno is now protecting [Server Name]!"

**What's Active Now**:
- ✅ Spam detection and auto-deletion
- ✅ Report and Track commands (right-click messages)
- ✅ Escalation system ready for mod team

**Next Steps** (Optional Configuration):

**Set Up Private Ticketing** (Recommended)
1. Go to the channel where you want the ticket button
2. Run `/tickets-channel` command
3. Customize button text and settings
[Learn more about ticketing →]

**Deploy Spam Honeypot** (Recommended)
1. Create a channel (name it "verify-here" or similar)
2. Position it at top of channel list
3. Run `/honeypot-setup` in that channel
4. Add warning message
[Learn more about honeypots →]

**Enable Reactji Forwarding** (Optional)
1. Go to your highlights/best-of channel
2. Run `/setup-reactji-channel emoji:⭐ threshold:5`
3. Messages with 5+ ⭐ reactions will be forwarded
[Learn more about reactji →]

**View Your Dashboard**
See community analytics and moderation activity:
[Go to Dashboard →]

**Need Help?**
- [Documentation](link)
- [Discord Support Server](link)
- [GitHub Issues](link)

---

## Additional Supporting Pages

### Pricing Page (`/pricing`)

**Free Tier** (Forever)
- All core moderation features
- Ticketing system
- Track & report system
- Escalation voting
- Spam protection (automod + honeypot)
- Reactji forwarding
- Basic analytics dashboard
- Community support

**Professional Tier** (Coming Soon)
- Everything in Free, plus:
- Advanced analytics and exports
- Priority support
- Longer data retention
- Multi-server management dashboard
- Custom branding options
- Early access to new features

**Enterprise** (Contact Sales)
- Everything in Professional, plus:
- Self-hosted deployment options
- SLA guarantees
- Dedicated support
- Custom feature development
- Compliance assistance

[Add to Discord (Free) →]

---

### Feature Deep-Dive Pages

Each feature gets a dedicated page with:
- Detailed explanation
- Screenshots/GIFs of the feature in action
- Use cases and examples
- Setup instructions
- Best practices

**Structure**:
- `/features/ticketing`
- `/features/moderation`
- `/features/spam-protection`
- `/features/analytics`
- `/features/reactji-forwarding`

---

## Marketing Copy Guidelines

### Voice & Tone

**For Corporate Audiences**:
- Professional, confident, data-driven
- Emphasize ROI, efficiency, compliance
- Use metrics and business outcomes
- Tone: Consultative and expert

**For Enthusiast Audiences**:
- Friendly, empathetic, community-focused
- Emphasize burnout prevention and fairness
- Use relatable scenarios and pain points
- Tone: Peer-to-peer and supportive

**For Incident Response**:
- Urgent but not panicky
- Clear and action-oriented
- Reassuring about simplicity
- Tone: Calm authority in crisis

### Key Messaging Themes

1. **Automation That Actually Works**
   - Not just another bot that needs constant babysitting
   - Intelligent automation that reduces work, doesn't create it

2. **Democracy & Fairness**
   - No more single-mod controversial decisions
   - Built-in consensus building and voting

3. **Peace of Mind**
   - Works 24/7 so moderators don't have to
   - Catches problems early before they escalate

4. **Low Cost, High Value**
   - Free tier has all essential features
   - No forced upgrades or feature gatekeeping
   - Built sustainably for long-term support

5. **Transparency & Trust**
   - Open source
   - No hidden data collection
   - Privacy-focused (data stays in Discord)

---

## Conversion Funnel Strategy

### Acquisition Channels (Low-Cost)

1. **Organic Search**
   - Target keywords: "Discord moderation bot", "Discord spam protection", "Discord ticketing bot"
   - SEO-optimized landing pages for each audience segment

2. **Community Word-of-Mouth**
   - Encourage satisfied users to recommend in Discord communities
   - Provide shareable "Protected by Euno" badges/graphics

3. **Content Marketing**
   - Blog posts on Discord moderation best practices
   - Case studies from real communities
   - Moderation guides and resources

4. **Discord Server Directories**
   - List on top.gg, discord.bots.gg, etc.
   - Optimize listings with clear value props

5. **GitHub & Developer Communities**
   - Open source positioning
   - Technical blog posts about architecture
   - Invite contributions

### Conversion Optimizations

**Landing Page**:
- Clear audience segmentation (corporate/enthusiast/crisis)
- Benefit-focused copy, not feature lists
- Strong CTAs above the fold
- Social proof (usage stats, testimonials)

**OAuth Flow**:
- Pre-select reasonable permissions
- Explain each permission clearly
- Show "trusted by X servers" social proof

**Onboarding**:
- Minimal required fields (just mod role + log channel)
- Immediate success confirmation
- Clear next steps for optional features
- In-app guidance for first commands

**Retention**:
- Dashboard showing bot's value (spam blocked, reports handled)
- Regular emails with community health insights
- Feature announcements and tips
- Optional upgrade prompts (non-intrusive)

---

## Success Metrics

### Primary KPIs

1. **Installation Rate**: New servers adding the bot per week
2. **Onboarding Completion**: % of installs that complete setup
3. **Feature Activation**: % using ticketing, honeypot, voting, etc.
4. **Retention**: % of servers still active after 30/60/90 days
5. **Referral Rate**: Organic growth from word-of-mouth

### Secondary Metrics

- Landing page conversion rates by audience segment
- Time-to-value (install → first moderation action)
- Feature usage patterns
- Dashboard engagement
- Support ticket volume (lower is better)

---

## Implementation Priorities

### Phase 1: Minimum Viable Marketing (Immediate)
1. ✅ Update homepage (`/`) with clear value prop and audience segmentation
2. ✅ Create three targeted landing pages (corporate, enthusiast, incident)
3. ✅ Ensure onboarding flow works smoothly
4. ✅ Add basic analytics tracking (PostHog already integrated)

### Phase 2: Content & SEO (Weeks 2-4)
1. Create feature deep-dive pages
2. Write 3-5 SEO-optimized blog posts
3. Document setup guides and best practices
4. Submit to bot directories

### Phase 3: Social Proof & Growth (Ongoing)
1. Collect and display testimonials
2. Create case studies from active servers
3. Build referral/badge system
4. Community engagement in support server

---

## Technical Requirements for Marketing Pages

### New Routes to Create

- `/for/teams` - Corporate landing
- `/for/communities` - Enthusiast landing  
- `/for/protection` - Incident response landing
- `/features/*` - Feature detail pages
- `/pricing` - Pricing page (update existing if present)

### Existing Routes to Update

- `/` (index.tsx) - Add audience segmentation
- `/onboard/:guildId` - Enhance with clearer next steps

### Assets Needed

1. Screenshots/recordings of:
   - Ticketing system in action
   - Report/track workflow
   - Escalation voting
   - Dashboard analytics
   - Setup process

2. Diagrams:
   - Architecture overview
   - Moderation workflow
   - Installation flow

3. Marketing graphics:
   - Social media images
   - "Protected by Euno" badges
   - Feature highlight graphics

---

## Copy Testing & Iteration

### A/B Test Opportunities

1. **Hero headline variations**
   - Problem-focused vs. solution-focused
   - Emotional vs. rational appeals

2. **CTA button text**
   - "Add to Discord" vs. "Get Started" vs. "Protect My Server"
   - Free vs. no mention of pricing

3. **Feature ordering**
   - Lead with automation vs. lead with fairness/voting
   - Spam protection vs. ticketing first

4. **Audience segmentation**
   - Three separate pages vs. single page with tabs
   - Explicit segmentation vs. universal messaging

### Feedback Collection

- Post-install survey: "What convinced you to try Euno?"
- Exit survey on landing pages: "What information are you missing?"
- Community feedback in support server
- Analytics on page engagement and drop-off points

---

## Conclusion

This marketing strategy positions Euno as:

1. **For Corporations**: A professional, reliable solution for scaling community operations with the audit trails and workflows that enterprises need.

2. **For Enthusiasts**: An empathetic tool that prevents mod burnout through automation and democratic decision-making.

3. **For Crisis Response**: An immediate, simple solution to urgent spam and safety threats.

The emphasis on sustainability means:
- Free tier has all core features (no aggressive upselling)
- Open source builds trust and enables customization
- Low-cost operations through efficient architecture
- Word-of-mouth growth over paid advertising

**Next Steps**: Implement Phase 1 (core landing pages), gather user feedback, iterate based on real conversion data.
