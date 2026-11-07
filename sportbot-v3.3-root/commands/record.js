'use strict';
const { SlashCommandBuilder } = require('discord.js');
const oddsService = require('../services/oddsService');
const tracker = require('../services/tracker');
const { recordEmbed, replyWithError } = require('./embeds');

const TITLES = { today: 'Bot record: today', '7d': 'Bot record: last 7 days', all: 'Bot record: all time' };

module.exports = {
  data: new SlashCommandBuilder()
    .setName('record')
    .setDescription("Check the bot's tracked win rate, calibration and daily results")
    .addStringOption(o => o.setName('period').setDescription('Time window (default: today)')
      .addChoices({ name: 'Today', value: 'today' }, { name: 'Last 7 days', value: '7d' }, { name: 'All time', value: 'all' }))
    .addStringOption(o => o.setName('sport').setDescription('Only one league').addChoices(...oddsService.SPORT_CHOICES)),

  async execute(interaction) {
    await interaction.deferReply();
    try {
      const period = interaction.options.getString('period') || 'today';
      const sport = interaction.options.getString('sport');
      await tracker.gradePending().catch(e => console.error('[record] grading:', e.message));   // throttled; free ESPN calls only
      const picks = tracker.selectPicks({ period, sport });
      const history = period === 'today' ? [] : tracker.dailyHistory(picks, 7);
      await interaction.editReply({ embeds: [recordEmbed(`${TITLES[period]}${sport ? ` (${sport.toUpperCase()})` : ''}`, tracker.summarize(picks), period === 'today' ? picks : [], history)] });
    } catch (err) {
      await replyWithError(interaction, err);
    }
  },
};
