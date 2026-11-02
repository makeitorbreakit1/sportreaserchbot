const axios = require('axios');

const BALLDONTLIE_API_URL = 'https://api.balldontlie.io/v1';

async function getTeamStats(season, teamId) {
    try {
        const response = await axios.get(`${BALLDONTLIE_API_URL}/season_averages`, {
            headers: { 
                // Pulls directly from Railway's Variables tab
                'Authorization': process.env.BALLDONTLIE_API_KEY 
            },
            params: { season: season, team_ids: [teamId] }
        });
        return response.data.data;
    } catch (error) {
        console.error('Error fetching Balldontlie team stats:', error.message);
        return null;
    }
}

async function getGamesByDate(dateString) {
    try {
        const response = await axios.get(`${BALLDONTLIE_API_URL}/games`, {
            headers: { 
                // Pulls directly from Railway's Variables tab
                'Authorization': process.env.BALLDONTLIE_API_KEY 
            },
            params: { dates: [dateString] }
        });
        return response.data.data;
    } catch (error) {
        console.error('Error fetching Balldontlie games:', error.message);
        return [];
    }
}

module.exports = {
    getTeamStats,
    getGamesByDate
};
