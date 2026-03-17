export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image } = req.body;
  if (!image) {
    return res.status(400).json({ error: 'No image provided' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ success: false, error: 'API key not configured' });
  }

  // Strip the data:image/...;base64, prefix if present
  const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
  const mediaType = image.match(/^data:(image\/\w+);/)?.[1] || 'image/jpeg';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Data
              }
            },
            {
              type: 'text',
              text: `You are a ventilation equipment expert working for eFans Direct, a UK trade supplier of extractor fans, MVHR units, and ventilation equipment.

Examine this photo of a fan ID plate / data plate / nameplate and extract as much information as possible.

Return a JSON object with these fields (use null for any field you can't determine):

{
  "manufacturer": "Brand/manufacturer name",
  "model": "Model name/number",
  "part_number": "Part number or SKU if different from model",
  "voltage": "e.g. 230V or 400V",
  "frequency": "e.g. 50Hz",
  "power": "e.g. 150W",
  "current": "e.g. 0.65A",
  "airflow": "e.g. 500 m\u00b3/h or 139 l/s",
  "speed": "e.g. 1400 RPM",
  "ip_rating": "e.g. IP44",
  "date": "Manufacturing date if visible",
  "notes": "Any other relevant info you can see — motor type (EC/AC), class, weight, country of origin, certification marks, etc."
}

If the image is NOT a fan ID plate (e.g. it's a photo of the fan housing, a random object, or unclear), still try to identify the fan type and manufacturer if possible, and note this in the "notes" field.

Return ONLY the JSON object, no other text.`
            }
          ]
        }]
      })
    });

    const data = await response.json();

    if (data.content && data.content[0] && data.content[0].text) {
      let text = data.content[0].text.trim();
      // Strip markdown code fences if present
      text = text.replace(/^\`\`\`json\s*/, '').replace(/\s*\`\`\`$/, '');

      try {
        const fields = JSON.parse(text);
        // Remove null fields
        const cleaned = {};
        for (const [k, v] of Object.entries(fields)) {
          if (v !== null && v !== '' && v !== 'null' && v !== 'N/A') {
            cleaned[k] = v;
          }
        }

        if (Object.keys(cleaned).length > 0) {
          return res.status(200).json({ success: true, fields: cleaned });
        } else {
          return res.status(200).json({ success: false, error: 'Could not extract any information' });
        }
      } catch (parseErr) {
        return res.status(200).json({ success: false, error: 'Could not parse AI response' });
      }
    }

    return res.status(200).json({ success: false, error: 'No response from AI' });

  } catch (err) {
    console.error('AI identification error:', err);
    return res.status(500).json({ success: false, error: 'AI service error' });
  }
}
