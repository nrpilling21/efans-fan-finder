export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Supabase not configured');
    return res.status(500).json({ success: false, error: 'Backend not configured' });
  }

  const {
    name, email, phone, company,
    duct_size, application, quantity, notes,
    ai_manufacturer, ai_model, ai_specs,
    images
  } = req.body;

  if (!name || !email) {
    return res.status(400).json({ success: false, error: 'Name and email are required' });
  }

  try {
    // Upload images to Supabase Storage
    const imageUrls = [];

    if (images && images.length > 0) {
      for (let i = 0; i < Math.min(images.length, 5); i++) {
        const base64 = images[i].replace(/^data:image\/\w+;base64,/, '');
        const ext = images[i].match(/^data:image\/(\w+);/)?.[1] || 'jpeg';
        const fileName = `enquiries/${Date.now()}_${i}.${ext}`;

        const uploadRes = await fetch(
          `${supabaseUrl}/storage/v1/object/fan-photos/${fileName}`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': `image/${ext}`,
              'x-upsert': 'true'
            },
            body: Buffer.from(base64, 'base64')
          }
        );

        if (uploadRes.ok) {
          imageUrls.push(`${supabaseUrl}/storage/v1/object/public/fan-photos/${fileName}`);
        }
      }
    }

    // Insert enquiry into Supabase
    const enquiry = {
      name,
      email,
      phone: phone || null,
      company: company || null,
      duct_size: duct_size || null,
      application: application || null,
      quantity: parseInt(quantity) || 1,
      notes: notes || null,
      ai_manufacturer: ai_manufacturer || null,
      ai_model: ai_model || null,
      ai_specs: ai_specs ? JSON.parse(ai_specs) : null,
      image_urls: imageUrls,
      status: 'new',
      created_at: new Date().toISOString()
    };

    const insertRes = await fetch(
      `${supabaseUrl}/rest/v1/fan_finder_enquiries`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'apikey': supabaseKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(enquiry)
      }
    );

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('Supabase insert error:', errText);
      return res.status(500).json({ success: false, error: 'Failed to save enquiry' });
    }

    // Send email notification via Supabase Edge Function or direct email
    // For now, we'll send a simple notification if NOTIFICATION_EMAIL is set
    const notifyEmail = process.env.NOTIFICATION_EMAIL;
    const resendKey = process.env.RESEND_API_KEY;

    if (resendKey && notifyEmail) {
      try {
        const fanInfo = ai_manufacturer && ai_model
          ? `${ai_manufacturer} ${ai_model}`
          : 'Not identified';

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Fan Finder <notifications@efans.co.uk>',
            to: notifyEmail,
            subject: `New Fan Finder Enquiry â ${fanInfo}`,
            html: `
              <h2>New Fan Replacement Enquiry</h2>
              <table style="border-collapse:collapse;width:100%;max-width:600px">
                <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold">Name</td><td style="padding:8px;border-bottom:1px solid #eee">${name}</td></tr>
                <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold">Email</td><td style="padding:8px;border-bottom:1px solid #eee"><a href="mailto:${email}">${email}</a></td></tr>
                ${phone ? `<tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold">Phone</td><td style="padding:8px;border-bottom:1px solid #eee"><a href="tel:${phone}">${phone}</a></td></tr>` : ''}
                ${company ? `<tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold">Company</td><td style="padding:8px;border-bottom:1px solid #eee">${company}</td></tr>` : ''}
                <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold">AI Identified</td><td style="padding:8px;border-bottom:1px solid #eee">${fanInfo}</td></tr>
                ${duct_size ? `<tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold">Duct Size</td><td style="padding:8px;border-bottom:1px solid #eee">${duct_size}</td></tr>` : ''}
                ${application ? `<tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold">Application</td><td style="padding:8px;border-bottom:1px solid #eee">${application}</td></tr>` : ''}
                <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold">Quantity</td><td style="padding:8px;border-bottom:1px solid #eee">${quantity || 1}</td></tr>
                ${notes ? `<tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold">Notes</td><td style="padding:8px;border-bottom:1px solid #eee">${notes}</td></tr>` : ''}
              </table>
              ${imageUrls.length > 0 ? `<h3 style="margin-top:20px">Photos</h3>${imageUrls.map(u => `<img src="${u}" style="max-width:400px;margin:8px 0;border-radius:8px" />`).join('')}` : ''}
            `
          })
        });
      } catch (emailErr) {
        console.error('Email notification failed:', emailErr);
        // Don't fail the request if email fails
      }
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Submit error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}
