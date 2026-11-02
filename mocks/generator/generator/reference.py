"""Static reference data: places, industries, banks and name parts."""

# State -> (GST state code, cities, relative weight for sampling)
STATES = {
    "Maharashtra": ("27", ["Mumbai", "Pune", "Nagpur", "Nashik", "Thane", "Aurangabad"], 16),
    "Gujarat": ("24", ["Ahmedabad", "Surat", "Vadodara", "Rajkot"], 10),
    "Karnataka": ("29", ["Bengaluru", "Mysuru", "Hubballi", "Mangaluru"], 9),
    "Tamil Nadu": ("33", ["Chennai", "Coimbatore", "Madurai", "Tiruppur"], 9),
    "Delhi": ("07", ["New Delhi"], 8),
    "Uttar Pradesh": ("09", ["Noida", "Lucknow", "Kanpur", "Agra", "Varanasi"], 7),
    "Telangana": ("36", ["Hyderabad", "Warangal"], 6),
    "West Bengal": ("19", ["Kolkata", "Howrah", "Durgapur"], 5),
    "Haryana": ("06", ["Gurugram", "Faridabad", "Panipat"], 5),
    "Rajasthan": ("08", ["Jaipur", "Jodhpur", "Udaipur"], 4),
    "Punjab": ("03", ["Ludhiana", "Amritsar", "Jalandhar"], 4),
    "Kerala": ("32", ["Kochi", "Thiruvananthapuram", "Kozhikode"], 3),
    "Madhya Pradesh": ("23", ["Indore", "Bhopal"], 3),
    "Andhra Pradesh": ("37", ["Visakhapatnam", "Vijayawada"], 3),
    "Odisha": ("21", ["Bhubaneswar", "Cuttack"], 2),
    "Bihar": ("10", ["Patna"], 1),
}

CONSTITUTIONS = {"Private Limited": 0.55, "Partnership": 0.20, "LLP": 0.15, "Public Limited": 0.10}
NAME_SUFFIX = {
    "Private Limited": ["Pvt Ltd", "Private Limited"],
    "Public Limited": ["Ltd", "Limited"],
    "LLP": ["LLP"],
    "Partnership": ["& Co", "Enterprises", "Traders", "Associates", "Brothers"],
}

# Industry -> (name words, GST rate, salary share of spend, cash-heavy, seasonality amplitude)
INDUSTRIES = {
    "Textiles": (["Textiles", "Fabrics", "Weaves", "Garments", "Spinning Mills"], 0.05, 0.14, False, 0.15),
    "Pharmaceuticals": (["Pharma", "Lifesciences", "Healthcare Labs", "Formulations"], 0.12, 0.16, False, 0.05),
    "Auto Components": (["Auto Parts", "Autotech", "Forgings", "Engineering Works"], 0.18, 0.15, False, 0.08),
    "Food Processing": (["Foods", "Agro Foods", "Dairy Products", "Spices"], 0.05, 0.10, True, 0.12),
    "Chemicals": (["Chemicals", "Dyes & Intermediates", "Specialty Chem"], 0.18, 0.10, False, 0.06),
    "Plastics & Polymers": (["Polymers", "Plastics", "Packaging Films"], 0.18, 0.11, False, 0.06),
    "Engineering": (["Engineers", "Fabricators", "Industries", "Machine Tools"], 0.18, 0.18, False, 0.07),
    "IT Services": (["Infotech", "Software Solutions", "Technologies", "Digital Services"], 0.18, 0.45, False, 0.04),
    "Construction": (["Constructions", "Infra Projects", "Builders", "Developers"], 0.12, 0.20, True, 0.18),
    "Logistics": (["Logistics", "Transport Co", "Roadways", "Cargo Movers"], 0.12, 0.22, True, 0.08),
    "Agro Products": (["Agro Industries", "Agritech", "Seeds", "Rice Mills"], 0.05, 0.08, True, 0.25),
    "Steel & Metals": (["Steels", "Metals", "Alloys", "Ispat"], 0.18, 0.08, False, 0.07),
    "Electronics": (["Electronics", "Electricals", "Power Systems"], 0.18, 0.14, False, 0.10),
    "Hospitality": (["Hotels", "Resorts", "Hospitality"], 0.12, 0.30, True, 0.20),
    "Retail Trade": (["Traders", "Mart", "Retail", "Distributors"], 0.12, 0.08, True, 0.15),
    "Gems & Jewellery": (["Jewellers", "Gems", "Diamonds"], 0.03, 0.06, True, 0.22),
    "Paper & Packaging": (["Paper Mills", "Packaging", "Corrugators"], 0.12, 0.10, False, 0.06),
    "Healthcare": (["Hospitals", "Diagnostics", "Medicare"], 0.05, 0.35, False, 0.04),
}

# Industry -> operating cash margin, % of 12 month GST turnover: the cash a company has for debt
# service in the DSCR of past loans. The same figures seed CREDORA.INDUSTRY_MARGIN in Exasol
# (exasol/sql/18_pricing_reference.sql), which prices the companies analysed now; a test keeps the
# two in step. Illustrative, see docs/PRICING.md.
CASH_MARGIN_PCT = {
    "Textiles": 9.0, "Pharmaceuticals": 18.0, "Auto Components": 12.0, "Food Processing": 8.0,
    "Chemicals": 15.0, "Plastics & Polymers": 11.0, "Engineering": 12.0, "IT Services": 20.0,
    "Construction": 10.0, "Logistics": 9.0, "Agro Products": 6.0, "Steel & Metals": 10.0,
    "Electronics": 10.0, "Hospitality": 22.0, "Retail Trade": 5.0, "Gems & Jewellery": 5.0,
    "Paper & Packaging": 12.0, "Healthcare": 18.0,
}

NAME_PREFIXES = [
    "Shree Ganesh", "Sai", "Balaji", "Om", "Lakshmi", "Surya", "Govind", "Shiva", "Ambika",
    "Vardhman", "Kaveri", "Narmada", "Ganga", "Himalaya", "Sahyadri", "Deccan", "Navkar",
    "Mahavir", "Jai Bharat", "Annapurna", "Bharat", "Apex", "Prime", "Zenith", "Sterling",
    "Pinnacle", "Vertex", "Orbit", "Galaxy", "Royal", "Supreme", "Global", "Indus", "Trident",
    "Saraswati", "Kalpataru", "Siddhivinayak", "Venkateswara", "Murugan", "Ajanta", "Konark",
    "Vishwakarma", "Shubh Labh", "Kailash", "Gayatri", "Aarav", "Nandi", "Jyoti", "Unnati", "Pragati",
    "Ashoka", "Amrit", "Arihant", "Akshay", "Alpha", "Ankur", "Asian", "Bhagwati", "Bhavani", "Chamunda",
    "Chetak", "Crystal", "Dhanlaxmi", "Diamond", "Divine", "Durga", "Eastern", "Ekta", "Everest", "Excel",
    "Garuda", "Gemini", "Goldline", "Gomti", "Hanuman", "Harsha", "Indo", "Jagannath", "Janata", "Jupiter",
    "Kamdhenu", "Kanchan", "Karnavati", "Keshav", "Kohinoor", "Kuber", "Lotus", "Madhav", "Mahalaxmi",
    "Malabar", "Mangalam", "Meridian", "Metro", "Mewar", "Modern", "Nalanda", "Navbharat", "Neelkanth",
    "Nilgiri", "Northern", "Omega", "Padmavati", "Panchsheel", "Paras", "Parijat", "Pioneer", "Popular",
    "Prabhat", "Pratap", "Prestige", "Rajhans", "Rajshree", "Ratna", "Rising Sun", "Sagar", "Samruddhi",
    "Sangam", "Sanjivani", "Satyam", "Shakti", "Shanti", "Shreeji", "Shubham", "Silverline", "Southern",
    "Sri Sai", "Star", "Sudarshan", "Sumangal", "Sunrise", "Swastik", "Tapi", "Trimurti", "Triveni",
    "Tulsi", "Ujjwal", "United", "Utkal", "Vaishnavi", "Vasundhara", "Vindhya", "Vrindavan", "Western",
    "Yamuna", "Chola", "Kalinga", "Magadh", "Malwa", "Saurashtra", "Konkan", "Mandovi", "Brahmaputra",
]
# Inserted between the industry word and the suffix once the plain names for a combination run out,
# e.g. "Sai Textiles Exports Pvt Ltd". Keeps company names unique across repeated appends.
NAME_QUALIFIERS = ["India", "International", "Overseas", "Exports", "Udyog", "Ventures", "Universal",
                   "Allied", "National", "Industrial", "Mercantile", "Impex"]

# Banks allowed for other-bank (AA) accounts; also used as lenders in CIBIL.
FIP_BANKS = [
    "State Bank of India", "HDFC Bank", "ICICI Bank", "Axis Bank", "Kotak Mahindra Bank",
    "Punjab National Bank", "Bank of Baroda", "Canara Bank", "Union Bank of India", "IndusInd Bank",
]
FIP_WEIGHTS = [20, 18, 15, 10, 8, 8, 7, 5, 5, 4]
NBFC_LENDERS = ["Bajaj Finance", "Tata Capital", "HDB Financial Services", "Aditya Birla Finance",
                "Muthoot Finance", "Mahindra Finance"]

# Consumer loan type -> (sanctioned amount range in rupees, tenure months)
CONSUMER_PRODUCTS = {
    "Home Loan": ((1_500_000, 15_000_000), 240),
    "Personal Loan": ((100_000, 2_000_000), 48),
    "Credit Card": ((50_000, 1_000_000), 0),
    "Auto Loan": ((400_000, 2_500_000), 60),
    "Business Loan": ((500_000, 5_000_000), 36),
    "Gold Loan": ((50_000, 1_000_000), 12),
}
CONSUMER_PRODUCT_WEIGHTS = [18, 20, 30, 15, 10, 7]

WC_PURPOSES = ["Working capital for inventory", "Receivables financing", "Seasonal stock build-up",
               "Raw material purchase", "Working capital enhancement"]
TL_PURPOSES = ["Purchase of machinery", "Factory expansion", "New warehouse", "Office premises",
               "Vehicle fleet purchase", "Solar rooftop plant", "Capacity expansion"]

SPEND_MERCHANTS = ["Amazon", "Flipkart", "Swiggy", "Zomato", "BigBasket", "Reliance Fresh", "DMart",
                   "Indian Oil", "HP Petrol Pump", "Tata Power", "Airtel", "Jio", "MakeMyTrip",
                   "Apollo Pharmacy", "Croma", "Uber", "Ola", "IRCTC", "Myntra", "Nykaa"]

# People's names for partners, directors and RMs. Curated here rather than drawn from Faker,
# so the synthetic data set is fully under the repo's control.
FIRST_NAMES_M = [
    "Aarav", "Aditya", "Ajay", "Akash", "Amit", "Anand", "Anil", "Arjun", "Ashok", "Deepak", "Dev", "Dinesh",
    "Gaurav", "Harish", "Hemant", "Imran", "Jatin", "Karan", "Kunal", "Lalit", "Manish", "Mohan", "Naveen",
    "Nikhil", "Nitin", "Pankaj", "Pradeep", "Rahul", "Rajesh", "Rakesh", "Ramesh", "Ravi", "Rohit", "Sachin",
    "Sandeep", "Sanjay", "Satish", "Siddharth", "Suresh", "Tarun", "Varun", "Vikram", "Vinod", "Vivek", "Yash",
    # west and central
    "Abhishek", "Alok", "Amar", "Aniket", "Bhavesh", "Chetan", "Chirag", "Darshan", "Hitesh", "Jignesh", "Ketan",
    "Mahesh", "Mukesh", "Omkar", "Paresh", "Parth", "Prashant", "Rupesh", "Sameer", "Santosh", "Tejas", "Tushar",
    "Vaibhav", "Yogesh", "Kapil", "Mayank", "Piyush", "Rohan",
    # north
    "Gautam", "Himanshu", "Jagdish", "Kamal", "Manoj", "Narendra", "Neeraj", "Rajiv", "Sanjeev", "Saurabh",
    "Shyam", "Sudhir", "Sumit", "Sunil", "Vijay", "Vinay", "Vishal", "Gurpreet", "Harpreet", "Jaspreet",
    "Manpreet", "Balwinder", "Abdul", "Farhan", "Irfan", "Salim",
    # east and north-east
    "Anirban", "Bijoy", "Bikash", "Biswajit", "Debashish", "Manas", "Partha", "Pradyumna", "Ranjit",
    "Sourav", "Subhash", "Sudipto", "Anup", "Hiranya", "Jyotirmoy",
    # south
    "Ajith", "Akhil", "Arun", "Arvind", "Ashwin", "Bhaskar", "Girish", "Gopal", "Hari", "Hemanth", "Jayant",
    "Karthik", "Kishore", "Lokesh", "Madhav", "Murali", "Muthu", "Nagaraj", "Prakash", "Pranav", "Raghav",
    "Rajeev", "Ravindra", "Senthil", "Shankar", "Shekhar", "Sreejith", "Sridhar", "Srinivas", "Uday",
    "Umesh", "Venkat", "Joseph", "Mathew", "Dhruv",
]
FIRST_NAMES_F = [
    "Aditi", "Ananya", "Anjali", "Bhavna", "Deepa", "Divya", "Farah", "Geeta", "Ishita", "Jyoti", "Kavita",
    "Kiran", "Lata", "Meena", "Meera", "Neha", "Nisha", "Pooja", "Priya", "Rashmi", "Rekha", "Ritu", "Sakshi",
    "Shalini", "Shreya", "Sneha", "Sonal", "Sunita", "Swati", "Tanvi", "Usha", "Vandana", "Varsha", "Zoya",
    # west and central
    "Aarti", "Akshata", "Bhagyashree", "Gauri", "Madhuri", "Manisha", "Mansi", "Namrata", "Prachi", "Rupali",
    "Sheetal", "Snehal", "Trupti", "Vaishali", "Smita", "Shilpa",
    # north
    "Alka", "Amrita", "Anita", "Archana", "Harleen", "Jasleen", "Monika", "Parul", "Poonam", "Preeti",
    "Ruchi", "Sangeeta", "Sarita", "Savita", "Seema", "Shweta", "Fatima", "Suman",
    # east and north-east
    "Debjani", "Ipsita", "Mitali", "Mousumi", "Rina", "Sushmita", "Tanushree", "Suchitra", "Swapna",
    "Durga", "Rupa",
    # south
    "Anupama", "Anusha", "Asha", "Bhavani", "Chitra", "Deepika", "Gayathri", "Hema", "Indira", "Jaya",
    "Kalpana", "Kamala", "Kavya", "Keerthi", "Lakshmi", "Lavanya", "Malini", "Mythili", "Nandini",
    "Nirmala", "Padma", "Pallavi", "Radha", "Radhika", "Revathi", "Shobha", "Sowmya", "Sudha", "Supriya",
    "Uma", "Vidya", "Yamini",
]
LAST_NAMES = [
    "Agarwal", "Ahuja", "Bajaj", "Banerjee", "Bhatia", "Bose", "Chatterjee", "Chopra", "Das", "Desai", "Dutta",
    "Gill", "Goel", "Gupta", "Iyer", "Jain", "Joshi", "Kapoor", "Khan", "Khanna", "Kulkarni", "Kumar", "Malhotra",
    "Mehta", "Menon", "Mishra", "Nair", "Naidu", "Pandey", "Patel", "Pillai", "Rao", "Reddy", "Saxena", "Sethi",
    "Shah", "Sharma", "Shetty", "Singh", "Sinha", "Srinivasan", "Thakur", "Trivedi", "Varma", "Verma", "Yadav",
    # west
    "Bhosale", "Chavan", "Deshmukh", "Deshpande", "Gokhale", "Jadhav", "Kamble", "Mane", "Patil", "Pawar",
    "Sawant", "Shinde", "Wagh", "Vaidya", "Thakkar", "Modi", "Parikh", "Parekh", "Dave", "Vyas", "Bhatt",
    "Soni", "Kothari", "Gandhi", "Naik",
    # north
    "Arora", "Bansal", "Bedi", "Bhardwaj", "Chauhan", "Chaudhary", "Chaturvedi", "Dhillon", "Dixit", "Dubey",
    "Garg", "Goyal", "Grewal", "Jindal", "Kalra", "Kaur", "Khatri", "Kohli", "Lal", "Mahajan", "Mathur",
    "Mittal", "Pandit", "Rastogi", "Rathore", "Rawat", "Sandhu", "Shukla", "Singhal", "Sodhi", "Srivastava",
    "Tandon", "Tewari", "Tripathi", "Upadhyay", "Ahluwalia", "Bajwa", "Ansari", "Qureshi",
    # east and north-east
    "Acharya", "Adhikari", "Behera", "Bhattacharya", "Biswas", "Chakraborty", "Choudhury", "Ghosh",
    "Majumdar", "Mohanty", "Mukherjee", "Nayak", "Panda", "Pradhan", "Rout", "Roy", "Sahu", "Sarkar", "Sen",
    "Sengupta", "Barua", "Bora", "Gogoi", "Kalita",
    # south
    "Bhat", "Chacko", "Chettiar", "Chowdary", "Gounder", "Gowda", "Hegde", "Kamath", "Kurian", "Kutty",
    "Murthy", "Nambiar", "Pai", "Panicker", "Raghavan", "Rajan", "Rangan", "Setty", "Shenoy", "Subramaniam",
    "Swamy", "Varghese", "Venkatesh", "Fernandes",
]
